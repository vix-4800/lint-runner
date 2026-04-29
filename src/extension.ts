import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    getRunnableFixers,
    getRunnableLinters,
    runFixers,
    runLinters,
    runRunnableLinters,
    resetCommandEnv,
    clearDiagnosticsCache,
    type RunnableFixer,
} from './linterRunner.js';

let untrustedWorkspaceWarningShown = false;
const skipFixersOnSave = new Set<string>();
const saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSavedContentHashes = new Map<string, string>();

export function computeContentHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Checks whether the document content has changed since the last save.
 * Updates the stored hash for the given key and returns true if the content
 * is new or different from the previously stored hash.
 */
export function isContentChanged(fileKey: string, newHash: string, hashMap: Map<string, string>): boolean {
    const prevHash = hashMap.get(fileKey);
    hashMap.set(fileKey, newHash);
    return prevHash !== newHash;
}

type OnOpenDocument = Pick<vscode.TextDocument, 'fileName' | 'isUntitled' | 'uri'>;
type OnOpenEditor = {
    readonly document: OnOpenDocument;
    readonly viewColumn?: vscode.ViewColumn;
};
type OnOpenTab = Pick<vscode.Tab, 'input'>;
type OnOpenTabGroup = {
    readonly activeTab: OnOpenTab | undefined;
    readonly viewColumn: vscode.ViewColumn;
};

interface FixerQuickPickItem extends vscode.QuickPickItem {
    fixer: RunnableFixer;
}

interface ActionQuickPickItem extends vscode.QuickPickItem {
    action?: () => Promise<void>;
}

function documentKey(document: Pick<vscode.TextDocument, 'uri'>): string {
    return document.uri.toString();
}

function isUserOpenDocument(document: OnOpenDocument): boolean {
    return document.uri.scheme === 'file' && !document.isUntitled;
}

function getActiveFileEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || !isUserOpenDocument(editor.document)) {
        return undefined;
    }

    return editor;
}

function addDiffDocumentUri(
    diffDocumentUrisByColumn: Map<vscode.ViewColumn, Set<string>>,
    viewColumn: vscode.ViewColumn,
    uri: vscode.Uri
): void {
    let diffDocumentUris = diffDocumentUrisByColumn.get(viewColumn);
    if (diffDocumentUris === undefined) {
        diffDocumentUris = new Set<string>();
        diffDocumentUrisByColumn.set(viewColumn, diffDocumentUris);
    }

    diffDocumentUris.add(uri.toString());
}

export function collectVisibleDiffDocumentUrisByColumn(
    tabGroups: readonly OnOpenTabGroup[]
): Map<vscode.ViewColumn, Set<string>> {
    const diffDocumentUrisByColumn = new Map<vscode.ViewColumn, Set<string>>();

    for (const group of tabGroups) {
        const input = group.activeTab?.input;
        if (!(input instanceof vscode.TabInputTextDiff)) {
            continue;
        }

        addDiffDocumentUri(diffDocumentUrisByColumn, group.viewColumn, input.original);
        addDiffDocumentUri(diffDocumentUrisByColumn, group.viewColumn, input.modified);
    }

    return diffDocumentUrisByColumn;
}

function isVisibleDiffDocument(
    editor: OnOpenEditor,
    diffDocumentUrisByColumn: ReadonlyMap<vscode.ViewColumn, ReadonlySet<string>>
): boolean {
    const key = documentKey(editor.document);

    if (editor.viewColumn !== undefined) {
        return diffDocumentUrisByColumn.get(editor.viewColumn)?.has(key) ?? false;
    }

    for (const diffDocumentUris of diffDocumentUrisByColumn.values()) {
        if (diffDocumentUris.has(key)) {
            return true;
        }
    }

    return false;
}

export function collectNewVisibleFileNames(
    editors: readonly OnOpenEditor[],
    seenDocumentUris: Set<string>,
    diffDocumentUrisByColumn: ReadonlyMap<vscode.ViewColumn, ReadonlySet<string>> = new Map()
): string[] {
    const fileNames: string[] = [];

    for (const editor of editors) {
        const document = editor.document;
        if (!isUserOpenDocument(document)) {
            continue;
        }

        if (isVisibleDiffDocument(editor, diffDocumentUrisByColumn)) {
            continue;
        }

        const key = documentKey(document);
        if (seenDocumentUris.has(key)) {
            continue;
        }

        seenDocumentUris.add(key);
        fileNames.push(document.fileName);
    }

    return fileNames;
}

function canRunWorkspaceCommands(showRepeatedWarning: boolean): boolean {
    if (vscode.workspace.isTrusted) {
        return true;
    }

    if (showRepeatedWarning || !untrustedWorkspaceWarningShown) {
        vscode.window.showWarningMessage(
            'LintRunner: Workspace is not trusted. Trust the workspace to run configured commands.'
        );
        untrustedWorkspaceWarningShown = true;
    }

    return false;
}

async function selectManualFixers(fileName: string): Promise<readonly RunnableFixer[] | undefined> {
    const fixers = getRunnableFixers(fileName, 'manual');
    if (fixers.length <= 1) {
        return fixers;
    }

    const items: FixerQuickPickItem[] = fixers.map((fixer) => ({
        label: fixer.label,
        description: fixer.description,
        detail: fixer.detail,
        fixer,
    }));
    const selectedItems = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select fixers to run',
        title: 'LintRunner: Run Fixers',
    });

    if (selectedItems === undefined || selectedItems.length === 0) {
        return undefined;
    }

    return selectedItems.map((item) => item.fixer);
}

function buildActionsTooltip(): string {
    const editor = getActiveFileEditor();
    if (editor === undefined) {
        return 'LintRunner: no active file';
    }

    const fileName = editor.document.fileName;
    const linters = getRunnableLinters(fileName, 'manual');
    const fixers = getRunnableFixers(fileName, 'manual');

    return `LintRunner: ${linters.length} linter(s), ${fixers.length} fixer(s) for ${editor.document.fileName}`;
}

function updateActionsStatusBar(statusBar: vscode.StatusBarItem): void {
    statusBar.text = '$(wrench)';
    statusBar.tooltip = buildActionsTooltip();
    statusBar.show();
}

async function runManualFixersForEditor(
    editor: vscode.TextEditor,
    diagnostics: vscode.DiagnosticCollection,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem,
    fixers?: readonly RunnableFixer[]
): Promise<void> {
    const fileName = editor.document.fileName;
    skipFixersOnSave.add(fileName);
    let saved: boolean;
    try {
        saved = await editor.document.save();
    } finally {
        skipFixersOnSave.delete(fileName);
    }
    if (!saved) {
        vscode.window.showWarningMessage('LintRunner: File was not saved.');
        return;
    }

    const selectedFixers = fixers ?? (await selectManualFixers(fileName));
    if (selectedFixers === undefined) {
        return;
    }
    if (selectedFixers.length === 0) {
        vscode.window.showWarningMessage('LintRunner: No matching fix command.');
        return;
    }

    await runFixers(fileName, output, statusBar, 'manual', selectedFixers);
    runLinters(fileName, 'manual', diagnostics, output, statusBar);
}

async function openActionsMenu(
    diagnostics: vscode.DiagnosticCollection,
    output: vscode.OutputChannel,
    runningStatusBar: vscode.StatusBarItem
): Promise<void> {
    const editor = getActiveFileEditor();
    if (editor === undefined) {
        vscode.window.showWarningMessage('LintRunner: No active file editor.');
        return;
    }
    if (!canRunWorkspaceCommands(true)) {
        return;
    }

    const fileName = editor.document.fileName;
    const linters = getRunnableLinters(fileName, 'manual');
    const fixers = getRunnableFixers(fileName, 'manual');
    if (linters.length === 0 && fixers.length === 0) {
        vscode.window.showWarningMessage('LintRunner: No matching linter or fix command.');
        return;
    }

    const items: ActionQuickPickItem[] = [];
    if (linters.length > 0) {
        items.push({
            label: '$(play) Run all linters',
            description: `${linters.length} command(s)`,
            action: async () => {
                runLinters(fileName, 'manual', diagnostics, output, runningStatusBar);
            },
        });
        items.push({
            kind: vscode.QuickPickItemKind.Separator,
            label: 'Linters',
        });
        items.push(
            ...linters.map((linter) => ({
                label: `$(play) ${linter.label}`,
                description: linter.description,
                detail: linter.detail,
                action: async () => {
                    await runRunnableLinters(
                        fileName,
                        diagnostics,
                        output,
                        runningStatusBar,
                        [linter]
                    );
                },
            }))
        );
    }

    if (fixers.length > 0) {
        items.push({
            label: '$(wrench) Run all fixers',
            description: `${fixers.length} command(s)`,
            action: async () => {
                await runManualFixersForEditor(
                    editor,
                    diagnostics,
                    output,
                    runningStatusBar,
                    fixers
                );
            },
        });
        items.push({
            kind: vscode.QuickPickItemKind.Separator,
            label: 'Fixers',
        });
        items.push(
            ...fixers.map((fixer) => ({
                label: `$(wrench) ${fixer.label}`,
                description: fixer.description,
                detail: fixer.detail,
                action: async () => {
                    await runManualFixersForEditor(
                        editor,
                        diagnostics,
                        output,
                        runningStatusBar,
                        [fixer]
                    );
                },
            }))
        );
    }

    const selectedItem = await vscode.window.showQuickPick(items, {
        placeHolder: 'Run linter or fixer for active file',
        title: 'LintRunner Actions',
    });

    await selectedItem?.action?.();
}

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner');
    const output = vscode.window.createOutputChannel('LintRunner');
    const runningStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    runningStatusBar.name = 'LintRunner';
    const actionsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    actionsStatusBar.name = 'LintRunner Actions';
    actionsStatusBar.command = 'lintRunner.actions';
    updateActionsStatusBar(actionsStatusBar);
    context.subscriptions.push(diagnostics, output, runningStatusBar, actionsStatusBar);

    const seenOnOpenDocumentUris = new Set<string>();
    collectNewVisibleFileNames(
        vscode.window.visibleTextEditors,
        seenOnOpenDocumentUris,
        collectVisibleDiffDocumentUrisByColumn(vscode.window.tabGroups.all)
    );

    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            if (!canRunWorkspaceCommands(false)) {
                return;
            }

            const diffDocumentUrisByColumn = collectVisibleDiffDocumentUrisByColumn(
                vscode.window.tabGroups.all
            );
            for (const fileName of collectNewVisibleFileNames(
                editors,
                seenOnOpenDocumentUris,
                diffDocumentUrisByColumn
            )) {
                runLinters(fileName, 'onOpen', diagnostics, output, runningStatusBar);
            }
            updateActionsStatusBar(actionsStatusBar);
        })
    );

    const debounceTimerDisposable: vscode.Disposable = {
        dispose() {
            for (const t of saveDebounceTimers.values()) {
                clearTimeout(t);
            }
            saveDebounceTimers.clear();
        },
    };

    context.subscriptions.push(
        debounceTimerDisposable,
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (!canRunWorkspaceCommands(false)) {
                return;
            }

            // Capture the fixer-skip flag synchronously before any async delay,
            // because runManualFixersForEditor removes the entry from the Set during
            // the save() call and the finally block runs right after it resolves.
            const skipFixer = skipFixersOnSave.delete(doc.fileName);

            const hash = computeContentHash(doc.getText());
            if (!isContentChanged(documentKey(doc), hash, lastSavedContentHashes)) {
                return;
            }

            const existingTimer = saveDebounceTimers.get(doc.fileName);
            if (existingTimer !== undefined) {
                clearTimeout(existingTimer);
            }

            const debounceMs =
                vscode.workspace.getConfiguration('lintRunner').get<number>('debounceMs') ?? 0;

            const doRun = async (): Promise<void> => {
                saveDebounceTimers.delete(doc.fileName);
                if (!skipFixer) {
                    await runFixers(doc.fileName, output, runningStatusBar, 'onSave');
                }
                runLinters(doc.fileName, 'onSave', diagnostics, output, runningStatusBar);
                updateActionsStatusBar(actionsStatusBar);
            };

            if (debounceMs <= 0) {
                await doRun();
            } else {
                const timer = setTimeout(() => { doRun().catch(() => undefined); }, debounceMs);
                saveDebounceTimers.set(doc.fileName, timer);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            seenOnOpenDocumentUris.delete(documentKey(doc));
            lastSavedContentHashes.delete(documentKey(doc));
            diagnostics.delete(doc.uri);
            updateActionsStatusBar(actionsStatusBar);
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            updateActionsStatusBar(actionsStatusBar);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('lintRunner')) {
                resetCommandEnv();
                clearDiagnosticsCache();
                updateActionsStatusBar(actionsStatusBar);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.run', () => {
            const editor = getActiveFileEditor();
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active file editor.');
                return;
            }
            if (!canRunWorkspaceCommands(true)) {
                return;
            }
            const fileName = editor.document.fileName;
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `LintRunner: Linting ${path.basename(fileName)}…`,
                    cancellable: false,
                },
                () => runLinters(fileName, 'manual', diagnostics, output, runningStatusBar)
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.fix', async () => {
            const editor = getActiveFileEditor();
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active file editor.');
                return;
            }
            if (!canRunWorkspaceCommands(true)) {
                return;
            }

            await runManualFixersForEditor(editor, diagnostics, output, runningStatusBar);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.clearDiagnostics', () => {
            const editor = getActiveFileEditor();
            if (editor !== undefined) {
                diagnostics.delete(editor.document.uri);
            } else {
                diagnostics.clear();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.actions', async () => {
            await openActionsMenu(diagnostics, output, runningStatusBar);
        })
    );
}

export function deactivate(): void {
    return;
}
