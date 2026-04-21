import * as vscode from 'vscode';
import { getRunnableFixers, runFixers, runLinters, type RunnableFixer } from './linterRunner.js';

let untrustedWorkspaceWarningShown = false;
const skipFixersOnSave = new Set<string>();

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

function documentKey(document: Pick<vscode.TextDocument, 'uri'>): string {
    return document.uri.toString();
}

function isUserOpenDocument(document: OnOpenDocument): boolean {
    return document.uri.scheme === 'file' && !document.isUntitled;
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

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner');
    const output = vscode.window.createOutputChannel('LintRunner');
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.name = 'LintRunner';
    context.subscriptions.push(diagnostics, output, statusBar);

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
                runLinters(fileName, 'onOpen', diagnostics, output, statusBar);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (!canRunWorkspaceCommands(false)) {
                return;
            }
            if (!skipFixersOnSave.delete(doc.fileName)) {
                await runFixers(doc.fileName, output, statusBar, 'onSave');
            }
            runLinters(doc.fileName, 'onSave', diagnostics, output, statusBar);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            seenOnOpenDocumentUris.delete(documentKey(doc));
            diagnostics.delete(doc.uri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.run', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active editor.');
                return;
            }
            if (!canRunWorkspaceCommands(true)) {
                return;
            }
            runLinters(editor.document.fileName, 'manual', diagnostics, output, statusBar);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.fix', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active editor.');
                return;
            }
            if (!canRunWorkspaceCommands(true)) {
                return;
            }

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

            const fixers = await selectManualFixers(fileName);
            if (fixers === undefined) {
                return;
            }
            if (fixers.length === 0) {
                vscode.window.showWarningMessage('LintRunner: No matching fix command.');
                return;
            }

            await runFixers(fileName, output, statusBar, 'manual', fixers);
            runLinters(fileName, 'manual', diagnostics, output, statusBar);
        })
    );
}

export function deactivate(): void {
    return;
}
