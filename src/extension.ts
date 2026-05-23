import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
    cancelAllFileRuns,
    cancelFileRun,
    getRunnableFixers,
    getRunnableLinters,
    isLintRunnerEnabled,
    runFixers,
    runLinters,
    runRunnableLinters,
    resetCommandEnv,
    clearDiagnosticsCache,
    clearFileLinterDiagnostics,
    clearAllFileLinterDiagnostics,
    clearFileDiagnosticsCache,
    validateLintRunnerConfig,
    type RunnerFailure,
    type RunnerOutput,
    type RunnableFixer,
    type RunnableLinter,
} from './linterRunner.js';

let untrustedWorkspaceWarningShown = false;
let configValidationIssues: string[] = [];
let configValidationWarningShown = false;
const skipFixersOnSave = new Set<string>();
const saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSavedContentHashes = new Map<string, string>();
const CONFIG_VALIDATION_PREVIEW_LIMIT = 5;

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
type OutputChannelLike = Pick<vscode.OutputChannel, 'appendLine' | 'dispose'>;
type CollectVisibleFileNamesOptions = {
    readonly includeSeen?: boolean;
};

interface FixerQuickPickItem extends vscode.QuickPickItem {
    fixer: RunnableFixer;
}

interface ActionQuickPickItem extends vscode.QuickPickItem {
    action?: () => Promise<void>;
}

interface ManualFixerRunnerDeps {
    saveDocumentBeforeManualFixers?: (document: vscode.TextDocument) => Promise<boolean>;
    selectManualFixers?: (fileName: string) => Promise<readonly RunnableFixer[] | undefined>;
    runWithManualNotification?: <T>(
        filePath: string,
        labels: readonly string[],
        task: () => Promise<T>
    ) => Promise<T>;
    runFixers?: (
        filePath: string,
        output: RunnerOutput,
        statusBar: vscode.StatusBarItem,
        trigger: 'manual',
        fixers: readonly RunnableFixer[]
    ) => Promise<number>;
    runLinters?: (
        filePath: string,
        trigger: 'onSave',
        diagnostics: vscode.DiagnosticCollection,
        output: RunnerOutput,
        statusBar: vscode.StatusBarItem
    ) => Promise<void>;
    showWarningMessage?: (message: string) => Thenable<string | undefined>;
}

interface ManualLinterRunnerDeps {
    runWithManualNotification?: <T>(
        filePath: string,
        labels: readonly string[],
        task: () => Promise<T>
    ) => Promise<T>;
    runLinters?: (
        filePath: string,
        trigger: 'manual',
        diagnostics: vscode.DiagnosticCollection,
        output: RunnerOutput,
        statusBar: vscode.StatusBarItem
    ) => Promise<void>;
    runRunnableLinters?: (
        filePath: string,
        diagnostics: vscode.DiagnosticCollection,
        output: RunnerOutput,
        statusBar: vscode.StatusBarItem,
        linters: readonly RunnableLinter[]
    ) => Promise<number>;
    showWarningMessage?: (message: string) => Thenable<string | undefined>;
}

const manualCodeActionKind = vscode.CodeActionKind.Source.append('lintRunner.manual');
const manualLinterCodeActionKind = manualCodeActionKind.append('linter');
const manualFixerCodeActionKind = manualCodeActionKind.append('fixer');
type WithProgressFn = <T>(
    options: vscode.ProgressOptions,
    task: (
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ) => Thenable<T>
) => Thenable<T>;

export function isLoggingEnabled(
    config: Pick<vscode.WorkspaceConfiguration, 'get'> = vscode.workspace.getConfiguration('lintRunner')
): boolean {
    return config.get<boolean>('enableLogging') !== false;
}

export function isManualRunNotificationEnabled(
    resourceOrConfig: vscode.Uri | Pick<vscode.WorkspaceConfiguration, 'get'> =
        vscode.workspace.getConfiguration('lintRunner')
): boolean {
    const config =
        resourceOrConfig instanceof vscode.Uri
            ? vscode.workspace.getConfiguration('lintRunner', resourceOrConfig)
            : resourceOrConfig;
    return config.get<boolean>('showManualRunNotifications') !== false;
}

function uniqueLabels(labels: readonly string[]): string[] {
    return [...new Set(labels.filter((label) => label !== ''))];
}

export function getManualRunNotificationTitle(labels: readonly string[]): string {
    const unique = uniqueLabels(labels);
    if (unique.length === 0) {
        return 'LintRunner: Running tools…';
    }
    if (unique.length === 1) {
        return `LintRunner: Running ${unique[0]}…`;
    }
    if (unique.length === 2) {
        return `LintRunner: Running ${unique.join(', ')}…`;
    }
    return `LintRunner: Running ${unique[0]}, ${unique[1]}, +${unique.length - 2} more…`;
}

interface ManualRunNotificationDeps {
    isEnabled?: (resource: vscode.Uri) => boolean;
    withProgress?: WithProgressFn;
    onCancel?: (filePath: string) => void;
}

export async function runManualTaskWithNotification<T>(
    filePath: string,
    labels: readonly string[],
    task: () => Promise<T>,
    deps: ManualRunNotificationDeps = {}
): Promise<T> {
    const resource = vscode.Uri.file(filePath);
    const isEnabled = deps.isEnabled ?? ((uri: vscode.Uri) => isManualRunNotificationEnabled(uri));
    if (!isEnabled(resource) || labels.length === 0) {
        return task();
    }

    const withProgress = deps.withProgress ?? vscode.window.withProgress.bind(vscode.window);
    const onCancel = deps.onCancel ?? cancelFileRun;
    return withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: getManualRunNotificationTitle(labels),
            cancellable: true,
        },
        async (_progress, token) => {
            const cancellation = token.onCancellationRequested(() => {
                onCancel(filePath);
            });
            try {
                return await task();
            } finally {
                cancellation.dispose();
            }
        }
    );
}

function createFailureAwareOutput(output: RunnerOutput, failures: RunnerFailure[]): RunnerOutput {
    return {
        appendLine(value: string): void {
            output.appendLine(value);
        },
        reportFailure(failure: RunnerFailure): void {
            failures.push(failure);
            output.reportFailure?.(failure);
        },
    };
}

function getManualRunFailureMessage(failures: readonly RunnerFailure[]): string | undefined {
    if (failures.length === 0) {
        return undefined;
    }

    if (failures.length === 1) {
        const [failure] = failures;
        return `LintRunner: ${failure.label} failed: ${failure.message}`;
    }

    const labels = uniqueLabels(failures.map((failure) => failure.label));
    const preview = labels.slice(0, 2);
    const suffix = labels.length > preview.length ? `, +${labels.length - preview.length} more` : '';
    return `LintRunner: ${labels.length} tools failed: ${preview.join(', ')}${suffix}. See output for details.`;
}

async function showManualRunFailureWarning(
    failures: readonly RunnerFailure[],
    showWarningMessage: (message: string) => Thenable<string | undefined>
): Promise<void> {
    const message = getManualRunFailureMessage(failures);
    if (message !== undefined) {
        await showWarningMessage(message);
    }
}

function hasValidConfig(): boolean {
    return configValidationIssues.length === 0;
}

function getConfigValidationMessage(issues: readonly string[]): string {
    const preview = issues.slice(0, CONFIG_VALIDATION_PREVIEW_LIMIT);
    const lines = preview.map((issue) => `• ${issue}`);
    if (issues.length > preview.length) {
        lines.push(`• +${issues.length - preview.length} more issue(s)`);
    }

    return `LintRunner: Config validation failed (${issues.length} issue(s)).\n${lines.join('\n')}`;
}

function showConfigValidationWarning(): void {
    if (configValidationIssues.length === 0) {
        return;
    }

    vscode.window.showWarningMessage(getConfigValidationMessage(configValidationIssues));
    configValidationWarningShown = true;
}

async function collectConfigValidationIssues(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const resources = workspaceFolders.length === 0 ? [undefined] : workspaceFolders.map((folder) => folder.uri);
    const results = await Promise.all(resources.map((resource) => validateLintRunnerConfig(resource)));
    return [...new Set(results.flat())];
}

async function refreshConfigValidation(showSuccessMessage = false): Promise<boolean> {
    configValidationIssues = await collectConfigValidationIssues();
    configValidationWarningShown = false;

    if (!hasValidConfig()) {
        showConfigValidationWarning();
        return false;
    }

    if (showSuccessMessage) {
        vscode.window.showInformationMessage('LintRunner: Config is valid.');
    }

    return true;
}

function shouldEnableOutputChannel(): boolean {
    return isLintRunnerEnabled() && isLoggingEnabled();
}

export class OutputChannelManager implements RunnerOutput, vscode.Disposable {
    private output: OutputChannelLike | undefined;

    constructor(
        private readonly createOutputChannel: () => OutputChannelLike = () =>
            vscode.window.createOutputChannel('LintRunner')
    ) {}

    appendLine(value: string): void {
        this.output?.appendLine(value);
    }

    sync(enabled: boolean): void {
        if (enabled) {
            this.output ??= this.createOutputChannel();
            return;
        }

        this.output?.dispose();
        this.output = undefined;
    }

    dispose(): void {
        this.output?.dispose();
        this.output = undefined;
    }
}

function documentKey(document: Pick<vscode.TextDocument, 'uri'>): string {
    return document.uri.toString();
}

export function clearPendingSaveDebounce(
    fileName: string,
    timers: Map<string, ReturnType<typeof setTimeout>> = saveDebounceTimers
): void {
    const existingTimer = timers.get(fileName);
    if (existingTimer === undefined) {
        return;
    }

    clearTimeout(existingTimer);
    timers.delete(fileName);
}

export function clearAllPendingSaveDebounces(
    timers: Map<string, ReturnType<typeof setTimeout>> = saveDebounceTimers
): void {
    for (const timer of timers.values()) {
        clearTimeout(timer);
    }
    timers.clear();
}

export function handleClosedDocument(
    document: Pick<vscode.TextDocument, 'fileName' | 'uri'>,
    seenDocumentUris: Set<string>,
    savedContentHashes: Map<string, string>,
    diagnostics: Pick<vscode.DiagnosticCollection, 'delete'>,
    timers: Map<string, ReturnType<typeof setTimeout>> = saveDebounceTimers,
    onCancelFileRun: (filePath: string) => void = cancelFileRun,
    onClearFileDiagnostics: (uriString: string) => void = clearFileLinterDiagnostics
): void {
    handleClosedFileUri(
        document.uri,
        document.fileName,
        seenDocumentUris,
        savedContentHashes,
        diagnostics,
        timers,
        onCancelFileRun,
        onClearFileDiagnostics
    );
}

export function handleClosedFileUri(
    uri: vscode.Uri,
    fileName: string,
    seenDocumentUris: Set<string>,
    savedContentHashes: Map<string, string>,
    diagnostics: Pick<vscode.DiagnosticCollection, 'delete'>,
    timers: Map<string, ReturnType<typeof setTimeout>> = saveDebounceTimers,
    onCancelFileRun: (filePath: string) => void = cancelFileRun,
    onClearFileDiagnostics: (uriString: string) => void = clearFileLinterDiagnostics
): void {
    const key = uri.toString();
    seenDocumentUris.delete(key);
    savedContentHashes.delete(key);
    clearPendingSaveDebounce(fileName, timers);
    onCancelFileRun(fileName);
    diagnostics.delete(uri);
    onClearFileDiagnostics(key);
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
    diffDocumentUrisByColumn: ReadonlyMap<vscode.ViewColumn, ReadonlySet<string>> = new Map(),
    options: CollectVisibleFileNamesOptions = {}
): string[] {
    const fileNames: string[] = [];
    const includeSeen = options.includeSeen === true;

    for (const editor of editors) {
        const document = editor.document;
        if (!isUserOpenDocument(document)) {
            continue;
        }

        if (isVisibleDiffDocument(editor, diffDocumentUrisByColumn)) {
            continue;
        }

        const key = documentKey(document);
        if (!includeSeen && seenDocumentUris.has(key)) {
            continue;
        }

        seenDocumentUris.add(key);
        fileNames.push(document.fileName);
    }

    return fileNames;
}

export function runOnOpenLintersForVisibleEditors(
    editors: readonly OnOpenEditor[],
    seenDocumentUris: Set<string>,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    tabGroups: readonly OnOpenTabGroup[] = vscode.window.tabGroups.all,
    options: CollectVisibleFileNamesOptions = {},
    onRunLinters: typeof runLinters = runLinters
): void {
    const diffDocumentUrisByColumn = collectVisibleDiffDocumentUrisByColumn(tabGroups);
    for (const fileName of collectNewVisibleFileNames(
        editors,
        seenDocumentUris,
        diffDocumentUrisByColumn,
        options
    )) {
        void onRunLinters(fileName, 'onOpen', diagnostics, output, statusBar);
    }
}

export function collectClosedFileTabUris(tabs: readonly OnOpenTab[]): vscode.Uri[] {
    const uris: vscode.Uri[] = [];

    for (const tab of tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && input.uri.scheme === 'file') {
            uris.push(input.uri);
        }
    }

    return uris;
}

function canRunWorkspaceCommands(showRepeatedWarning: boolean): boolean {
    if (!isLintRunnerEnabled()) {
        if (showRepeatedWarning) {
            vscode.window.showWarningMessage(
                'LintRunner: Extension is disabled. Set lintRunner.enabled to true to run commands.'
            );
        }
        return false;
    }

    if (!hasValidConfig()) {
        if (showRepeatedWarning || !configValidationWarningShown) {
            showConfigValidationWarning();
        }
        return false;
    }

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

export function getActionsStatusBarState(
    editor: Pick<vscode.TextEditor, 'document'> | undefined = getActiveFileEditor(),
    isEnabled: (resource: vscode.Uri) => boolean = isLintRunnerEnabled,
    isConfigValid: () => boolean = hasValidConfig
): { text: string; tooltip: string } | undefined {
    if (
        editor === undefined ||
        !isUserOpenDocument(editor.document) ||
        !isEnabled(editor.document.uri) ||
        !isConfigValid()
    ) {
        return undefined;
    }

    const fileName = editor.document.fileName;
    const linters = getRunnableLinters(fileName, 'manual');
    const fixers = getRunnableFixers(fileName, 'manual');

    return {
        text: '$(wrench)',
        tooltip:
            `LintRunner: ${linters.length} linter(s), ${fixers.length} fixer(s) for ${vscode.workspace.asRelativePath(editor.document.fileName)}`,
    };
}

function updateActionsStatusBar(statusBar: vscode.StatusBarItem): void {
    const state = getActionsStatusBarState();
    if (state === undefined) {
        statusBar.hide();
        return;
    }

    statusBar.text = state.text;
    statusBar.tooltip = state.tooltip;
    statusBar.show();
}

function findVisibleFileEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(
        (editor) => editor.document.uri.toString() === uri.toString()
    );
}

function getRunnableLinterLabels(linters: readonly RunnableLinter[]): string[] {
    return linters.map((linter) => `${linter.description}:${linter.label}`);
}

function getRunnableFixerLabels(fixers: readonly RunnableFixer[]): string[] {
    return fixers.map((fixer) => `${fixer.targetName}:fix:${fixer.label}`);
}

async function saveDocumentBeforeManualFixers(document: vscode.TextDocument): Promise<boolean> {
    skipFixersOnSave.add(document.fileName);
    try {
        return await document.save();
    } finally {
        skipFixersOnSave.delete(document.fileName);
    }
}

export function isManualCodeActionLinter(runnable: RunnableLinter): boolean {
    return runnable.linter.run === 'manual';
}

export function isManualCodeActionFixer(runnable: RunnableFixer): boolean {
    return runnable.fixer.run !== 'onSave';
}

export function createManualCodeActions(
    documentUri: vscode.Uri,
    linters: readonly RunnableLinter[],
    fixers: readonly RunnableFixer[]
): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const linter of linters) {
        const title = `Run linter: ${linter.label} (${linter.description})`;
        const action = new vscode.CodeAction(title, manualLinterCodeActionKind);
        action.command = {
            title,
            command: 'lintRunner.runManualLinterCodeAction',
            arguments: [documentUri, linter],
        };
        actions.push(action);
    }

    for (const fixer of fixers) {
        const title = `Run fixer: ${fixer.label} (${fixer.description})`;
        const action = new vscode.CodeAction(title, manualFixerCodeActionKind);
        action.command = {
            title,
            command: 'lintRunner.runManualFixerCodeAction',
            arguments: [documentUri, fixer],
        };
        actions.push(action);
    }

    return actions;
}

export function createManualCodeLenses(
    documentUri: vscode.Uri,
    linters: readonly RunnableLinter[],
    fixers: readonly RunnableFixer[]
): vscode.CodeLens[] {
    const range = new vscode.Range(0, 0, 0, 0);
    const codeLenses: vscode.CodeLens[] = [];

    for (const linter of linters) {
        const title = `Lint: ${linter.label} (${linter.description})`;
        codeLenses.push(
            new vscode.CodeLens(range, {
                title,
                command: 'lintRunner.runManualLinterCodeAction',
                arguments: [documentUri, linter],
            })
        );
    }

    for (const fixer of fixers) {
        const title = `Fix: ${fixer.label} (${fixer.description})`;
        codeLenses.push(
            new vscode.CodeLens(range, {
                title,
                command: 'lintRunner.runManualFixerCodeAction',
                arguments: [documentUri, fixer],
            })
        );
    }

    return codeLenses;
}

export async function runManualFixersForEditor(
    editorOrUri: vscode.TextEditor | vscode.Uri,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    fixers?: readonly RunnableFixer[],
    deps: ManualFixerRunnerDeps = {}
): Promise<void> {
    const saveDocument = deps.saveDocumentBeforeManualFixers ?? saveDocumentBeforeManualFixers;
    const selectFixers = deps.selectManualFixers ?? selectManualFixers;
    const runWithManualNotification = deps.runWithManualNotification ?? runManualTaskWithNotification;
    const runSelectedFixers = deps.runFixers ?? runFixers;
    const refreshLinters = deps.runLinters ?? runLinters;
    const showWarningMessage = deps.showWarningMessage ?? vscode.window.showWarningMessage;
    const documentUri = editorOrUri instanceof vscode.Uri ? editorOrUri : editorOrUri.document.uri;
    const editor = editorOrUri instanceof vscode.Uri ? findVisibleFileEditor(documentUri) : editorOrUri;
    if (editor === undefined) {
        await showWarningMessage('LintRunner: No visible file editor for fixer action.');
        return;
    }

    const document = editor.document;
    const fileName = document.fileName;

    const saved = await saveDocument(document);
    if (!saved) {
        await showWarningMessage('LintRunner: File was not saved.');
        return;
    }

    const selectedFixers = fixers ?? (await selectFixers(fileName));
    if (selectedFixers === undefined) {
        return;
    }
    if (selectedFixers.length === 0) {
        await showWarningMessage('LintRunner: No matching fix command.');
        return;
    }

    const failures: RunnerFailure[] = [];
    const failureAwareOutput = createFailureAwareOutput(output, failures);
    await runWithManualNotification(fileName, getRunnableFixerLabels(selectedFixers), async () =>
        runSelectedFixers(fileName, failureAwareOutput, statusBar, 'manual', selectedFixers)
    );
    await showManualRunFailureWarning(failures, showWarningMessage);
    await refreshLinters(fileName, 'onSave', diagnostics, output, statusBar);
}

export async function runManualLintersForFile(
    fileName: string,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    linters?: readonly RunnableLinter[],
    deps: ManualLinterRunnerDeps = {}
): Promise<void> {
    const manualLinters = linters ?? getRunnableLinters(fileName, 'manual');
    const runWithManualNotification = deps.runWithManualNotification ?? runManualTaskWithNotification;
    const runSelectedLinters = deps.runRunnableLinters ?? runRunnableLinters;
    const runAllLinters = deps.runLinters ?? runLinters;
    const showWarningMessage = deps.showWarningMessage ?? vscode.window.showWarningMessage;
    const failures: RunnerFailure[] = [];
    const failureAwareOutput = createFailureAwareOutput(output, failures);

    await runWithManualNotification(fileName, getRunnableLinterLabels(manualLinters), async () =>
        linters === undefined
            ? runAllLinters(fileName, 'manual', diagnostics, failureAwareOutput, statusBar)
            : runSelectedLinters(fileName, diagnostics, failureAwareOutput, statusBar, manualLinters)
    );
    await showManualRunFailureWarning(failures, showWarningMessage);
}

async function openActionsMenu(
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    runningStatusBar: vscode.StatusBarItem
): Promise<void> {
    const editor = getActiveFileEditor();
    if (editor === undefined) {
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
                await runManualLintersForFile(fileName, diagnostics, output, runningStatusBar);
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
                    await runManualLintersForFile(fileName, diagnostics, output, runningStatusBar, [linter]);
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner');
    const output = new OutputChannelManager();
    output.sync(shouldEnableOutputChannel());
    const runningStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    runningStatusBar.name = 'LintRunner';
    runningStatusBar.command = 'lintRunner.stopRunningTools';
    const actionsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    const codeLensRefreshEmitter = new vscode.EventEmitter<void>();
    actionsStatusBar.name = 'LintRunner Actions';
    actionsStatusBar.command = 'lintRunner.actions';
    updateActionsStatusBar(actionsStatusBar);
    context.subscriptions.push(diagnostics, output, runningStatusBar, actionsStatusBar, codeLensRefreshEmitter);

    const seenOnOpenDocumentUris = new Set<string>();
    let lintRunnerEnabled = isLintRunnerEnabled();
    let configValid = await refreshConfigValidation();
    updateActionsStatusBar(actionsStatusBar);
    codeLensRefreshEmitter.fire();
    if (canRunWorkspaceCommands(false)) {
        runOnOpenLintersForVisibleEditors(
            vscode.window.visibleTextEditors,
            seenOnOpenDocumentUris,
            diagnostics,
            output,
            runningStatusBar
        );
    } else {
        collectNewVisibleFileNames(
            vscode.window.visibleTextEditors,
            seenOnOpenDocumentUris,
            collectVisibleDiffDocumentUrisByColumn(vscode.window.tabGroups.all)
        );
    }

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
            onDidChangeCodeLenses: codeLensRefreshEmitter.event,
            provideCodeLenses(document) {
                const config = vscode.workspace.getConfiguration('lintRunner', document.uri);
                if (
                    !isLintRunnerEnabled(config) ||
                    !hasValidConfig() ||
                    config.get<boolean>('enableCodeLens') !== true ||
                    !vscode.workspace.isTrusted
                ) {
                    return [];
                }

                const fileName = document.fileName;
                return createManualCodeLenses(
                    document.uri,
                    getRunnableLinters(fileName, 'manual').filter(isManualCodeActionLinter),
                    getRunnableFixers(fileName, 'manual').filter(isManualCodeActionFixer)
                );
            },
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file' },
            {
                provideCodeActions(document) {
                    const config = vscode.workspace.getConfiguration('lintRunner', document.uri);
                    if (
                        !isLintRunnerEnabled(config) ||
                        !hasValidConfig() ||
                        config.get<boolean>('enableCodeActions') !== true ||
                        !vscode.workspace.isTrusted
                    ) {
                        return [];
                    }

                    const fileName = document.fileName;
                    return createManualCodeActions(
                        document.uri,
                        getRunnableLinters(fileName, 'manual').filter(isManualCodeActionLinter),
                        getRunnableFixers(fileName, 'manual').filter(isManualCodeActionFixer)
                    );
                },
            },
            {
                providedCodeActionKinds: [manualLinterCodeActionKind, manualFixerCodeActionKind],
            }
        )
    );

    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            if (!canRunWorkspaceCommands(false)) {
                return;
            }

            runOnOpenLintersForVisibleEditors(
                editors,
                seenOnOpenDocumentUris,
                diagnostics,
                output,
                runningStatusBar
            );
            updateActionsStatusBar(actionsStatusBar);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            if (!canRunWorkspaceCommands(false)) {
                return;
            }

            runOnOpenLintersForVisibleEditors(
                vscode.window.visibleTextEditors,
                seenOnOpenDocumentUris,
                diagnostics,
                output,
                runningStatusBar,
                vscode.window.tabGroups.all,
                { includeSeen: true }
            );
            updateActionsStatusBar(actionsStatusBar);
            codeLensRefreshEmitter.fire();
        })
    );

    const debounceTimerDisposable: vscode.Disposable = {
        dispose() {
            clearAllPendingSaveDebounces();
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
                vscode.workspace.getConfiguration('lintRunner', doc.uri).get<number>('debounceMs') ?? 0;

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
            handleClosedDocument(doc, seenOnOpenDocumentUris, lastSavedContentHashes, diagnostics);
            updateActionsStatusBar(actionsStatusBar);
        })
    );

    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs((event) => {
            for (const uri of collectClosedFileTabUris(event.closed)) {
                handleClosedFileUri(
                    uri,
                    uri.fsPath,
                    seenOnOpenDocumentUris,
                    lastSavedContentHashes,
                    diagnostics
                );
            }
            updateActionsStatusBar(actionsStatusBar);
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            updateActionsStatusBar(actionsStatusBar);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration('lintRunner')) {
                const wasEnabled = lintRunnerEnabled;
                const wasConfigValid = configValid;
                resetCommandEnv();
                clearDiagnosticsCache();
                clearAllPendingSaveDebounces();
                cancelAllFileRuns();
                diagnostics.clear();
                runningStatusBar.hide();
                output.sync(shouldEnableOutputChannel());
                updateActionsStatusBar(actionsStatusBar);
                codeLensRefreshEmitter.fire();
                lintRunnerEnabled = isLintRunnerEnabled();
                configValid = await refreshConfigValidation();

                if (
                    (!wasEnabled || !wasConfigValid) &&
                    lintRunnerEnabled &&
                    configValid &&
                    vscode.workspace.isTrusted
                ) {
                    runOnOpenLintersForVisibleEditors(
                        vscode.window.visibleTextEditors,
                        seenOnOpenDocumentUris,
                        diagnostics,
                        output,
                        runningStatusBar,
                        vscode.window.tabGroups.all,
                        { includeSeen: true }
                    );
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.validateConfig', async () => {
            configValid = await refreshConfigValidation(true);
            updateActionsStatusBar(actionsStatusBar);
            codeLensRefreshEmitter.fire();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.run', async () => {
            const editor = getActiveFileEditor();
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active file editor.');
                return;
            }
            if (!canRunWorkspaceCommands(true)) {
                return;
            }
            const fileName = editor.document.fileName;
            await runManualLintersForFile(fileName, diagnostics, output, runningStatusBar);
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
        vscode.commands.registerCommand(
            'lintRunner.runManualLinterCodeAction',
            async (uri: vscode.Uri, linter: RunnableLinter) => {
                if (!canRunWorkspaceCommands(true)) {
                    return;
                }

                await runManualLintersForFile(uri.fsPath, diagnostics, output, runningStatusBar, [linter]);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'lintRunner.runManualFixerCodeAction',
            async (uri: vscode.Uri, fixer: RunnableFixer) => {
                if (!canRunWorkspaceCommands(true)) {
                    return;
                }

                await runManualFixersForEditor(uri, diagnostics, output, runningStatusBar, [fixer]);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.stopRunningTools', () => {
            cancelAllFileRuns();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.clearDiagnostics', () => {
            if (!canRunWorkspaceCommands(true)) {
                return;
            }
            const editor = getActiveFileEditor();
            if (editor !== undefined) {
                const uri = editor.document.uri;
                diagnostics.delete(uri);
                clearFileLinterDiagnostics(uri.toString());
                clearFileDiagnosticsCache(uri.fsPath);
            } else {
                diagnostics.clear();
                clearAllFileLinterDiagnostics();
                clearDiagnosticsCache();
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
