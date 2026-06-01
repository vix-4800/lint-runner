import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    cancelAllFileRuns,
    cancelFileRun,
    clearAllFileToolDiagnostics,
    clearDiagnosticsCache,
    clearFileDiagnosticsCache,
    clearFileToolDiagnostics,
    clearRunnerRuntimeState,
    getDoctorToolStatuses,
    getRunnablePipelines,
    getRunnableTools,
    isLintRunnerEnabled,
    resetCommandEnv,
    runPipeline,
    validateLintRunnerConfig,
    type ConfigValidationIssues,
    type DoctorToolStatus,
    type RunPipelineOptions,
    type RunnablePipeline,
    type RunnableTool,
    type RunnerFailure,
    type RunnerOutput,
} from './toolRunner.js';

export type { RunnablePipeline, RunnableTool } from './toolRunner.js';

let untrustedWorkspaceWarningShown = false;
let configValidationIssues: ConfigValidationIssues = { errors: [], warnings: [] };
let configValidationWarningShown = false;
const saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSavedContentHashes = new Map<string, string>();
const CONFIG_VALIDATION_PREVIEW_LIMIT = 5;
const MANUAL_RUN_FAILURE_NOTIFICATION_MS = 4000;
const UNTITLED_LANGUAGE_EXTENSIONS: Record<string, string> = {
    css: '.css',
    go: '.go',
    html: '.html',
    javascript: '.js',
    javascriptreact: '.jsx',
    json: '.json',
    lua: '.lua',
    markdown: '.md',
    php: '.php',
    plaintext: '.txt',
    python: '.py',
    shellscript: '.sh',
    typescript: '.ts',
    typescriptreact: '.tsx',
    vue: '.vue',
    xml: '.xml',
    yaml: '.yml',
};
const manualCodeActionKind = vscode.CodeActionKind.Source.append('lintRunner.manual');
const manualPipelineCodeActionKind = manualCodeActionKind.append('pipeline');
const manualToolCodeActionKind = manualCodeActionKind.append('tool');

type OutputChannelLike = Pick<vscode.OutputChannel, 'appendLine' | 'dispose'>;
type StatusBarLike = Pick<vscode.StatusBarItem, 'dispose' | 'hide'>;
type DiagnosticsLike = Pick<vscode.DiagnosticCollection, 'clear' | 'dispose'>;
type DisposableLike = Pick<vscode.Disposable, 'dispose'>;
type DelayFn = (ms: number) => Promise<void>;
type WithProgressFn = <T>(
    options: vscode.ProgressOptions,
    task: (
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ) => Thenable<T>
) => Thenable<T>;

interface OnOpenDocument {
    readonly fileName: string;
    readonly isUntitled: boolean;
    readonly uri: vscode.Uri;
}

interface OnOpenEditor {
    readonly document: OnOpenDocument;
    readonly viewColumn?: vscode.ViewColumn;
}

interface OnOpenTab {
    readonly input: unknown;
}

interface OnOpenTabGroup {
    readonly activeTab: OnOpenTab | undefined;
    readonly viewColumn: vscode.ViewColumn;
}

interface CollectVisibleFileNamesOptions {
    readonly includeSeen?: boolean;
}

interface ActionQuickPickItem extends vscode.QuickPickItem {
    action?: () => Promise<void>;
}

interface DeactivateCleanupDeps {
    clearPendingSaveDebounces?: () => void;
    clearRunnerRuntimeState?: () => void;
    savedContentHashes?: Map<string, string>;
    seenOnOpenDocumentUris?: Set<string>;
    diagnostics?: DiagnosticsLike;
    runningStatusBar?: StatusBarLike;
    actionsStatusBar?: StatusBarLike;
    output?: OutputChannelLike;
    codeLensRefreshEmitter?: DisposableLike;
}

interface ManualRunNotificationDeps {
    isEnabled?: (resource: vscode.Uri) => boolean;
    withProgress?: WithProgressFn;
    onCancel?: (filePath: string) => void;
}

interface ManualRunFailureWarningDeps {
    delay?: DelayFn;
    showWarningMessage?: typeof vscode.window.showWarningMessage;
    withProgress?: WithProgressFn;
}

interface DoctorNotificationDeps {
    getStatuses?: (resource?: vscode.Uri) => Promise<DoctorToolStatus[]>;
    withProgress?: WithProgressFn;
    openTextDocument?: typeof vscode.workspace.openTextDocument;
    showTextDocument?: typeof vscode.window.showTextDocument;
    executeCommand?: (command: string, ...rest: unknown[]) => Thenable<unknown>;
    showInformationMessage?: typeof vscode.window.showInformationMessage;
}

interface OpenBundledExamplesDeps {
    openTextDocument?: typeof vscode.workspace.openTextDocument;
    showTextDocument?: typeof vscode.window.showTextDocument;
}

interface RunnableTextDocument extends Pick<
    vscode.TextDocument,
    'fileName' | 'getText' | 'isUntitled' | 'languageId' | 'lineCount' | 'uri'
> {}

type RunManualPipelinesForFileFn = (
    fileName: string,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    pipelines?: readonly RunnablePipeline[],
    options?: RunPipelineOptions
) => Promise<void>;

interface ManualDocumentRunDeps {
    runManualPipelinesForFile?: RunManualPipelinesForFileFn;
    applyWorkspaceEdit?: typeof vscode.workspace.applyEdit;
}

let deactivateCleanupResources: Omit<
    DeactivateCleanupDeps,
    'clearPendingSaveDebounces' | 'clearRunnerRuntimeState' | 'savedContentHashes'
> | undefined;

export function computeContentHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

export function isContentChanged(fileKey: string, newHash: string, hashMap: Map<string, string>): boolean {
    const prevHash = hashMap.get(fileKey);
    hashMap.set(fileKey, newHash);
    return prevHash !== newHash;
}

export function isLoggingEnabled(
    config: Pick<vscode.WorkspaceConfiguration, 'get'> = vscode.workspace.getConfiguration('lintRunner')
): boolean {
    return config.get<boolean>('enableLogging') !== false;
}

export function isManualRunNotificationEnabled(
    resourceOrConfig: Pick<vscode.WorkspaceConfiguration, 'get'> | vscode.Uri =
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
        return 'LintRunner: Running tools...';
    }
    if (unique.length === 1) {
        return `LintRunner: Running ${unique[0]}...`;
    }
    if (unique.length === 2) {
        return `LintRunner: Running ${unique.join(', ')}...`;
    }
    return `LintRunner: Running ${unique[0]}, ${unique[1]}, +${unique.length - 2} more...`;
}

export function formatDoctorTable(rows: readonly DoctorToolStatus[]): string {
    const headers = ['Tool', 'Found', 'Version', 'Used by'];
    const formatCell = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ');
    const formatRow = (row: readonly string[]): string => `| ${row.map(formatCell).join(' | ')} |`;
    const cells = rows.map((row) => [row.tool, row.found, row.version, row.usedBy.join(', ')]);
    return [formatRow(headers), formatRow(headers.map(() => '---')), ...cells.map((row) => formatRow(row))].join('\n');
}

export class OutputChannelManager implements RunnerOutput, vscode.Disposable {
    private output: vscode.OutputChannel | undefined;

    public constructor(
        private readonly createOutputChannel: typeof vscode.window.createOutputChannel = vscode.window.createOutputChannel
    ) {}

    public sync(enabled: boolean): void {
        if (enabled && this.output === undefined) {
            this.output = this.createOutputChannel('LintRunner');
        }
        if (!enabled && this.output !== undefined) {
            this.output.dispose();
            this.output = undefined;
        }
    }

    public appendLine(value: string): void {
        this.output?.appendLine(value);
    }

    public dispose(): void {
        this.output?.dispose();
        this.output = undefined;
    }
}

function documentKey(doc: Pick<vscode.TextDocument, 'uri'>): string {
    return doc.uri.toString();
}

function isVisibleDiffDocument(tab: OnOpenTab | undefined): tab is OnOpenTab & { input: vscode.TabInputTextDiff } {
    return tab !== undefined && tab.input instanceof vscode.TabInputTextDiff;
}

export function collectVisibleDiffDocumentUrisByColumn(tabGroups: readonly OnOpenTabGroup[]): Map<vscode.ViewColumn, Set<string>> {
    const result = new Map<vscode.ViewColumn, Set<string>>();
    for (const group of tabGroups) {
        const tab = group.activeTab;
        if (!isVisibleDiffDocument(tab)) {
            continue;
        }
        const uris = result.get(group.viewColumn) ?? new Set<string>();
        uris.add(tab.input.original.toString());
        uris.add(tab.input.modified.toString());
        result.set(group.viewColumn, uris);
    }
    return result;
}

export function collectNewVisibleFileNames(
    editors: readonly OnOpenEditor[],
    seenDocumentUris: Set<string>,
    diffDocumentUrisByColumn: Map<vscode.ViewColumn, Set<string>>,
    options: CollectVisibleFileNamesOptions = {}
): string[] {
    const files: string[] = [];
    for (const editor of editors) {
        const doc = editor.document;
        if (doc.isUntitled || doc.uri.scheme !== 'file') {
            continue;
        }
        if (editor.viewColumn !== undefined && diffDocumentUrisByColumn.get(editor.viewColumn)?.has(doc.uri.toString())) {
            continue;
        }
        const key = doc.uri.toString();
        if (!options.includeSeen && seenDocumentUris.has(key)) {
            continue;
        }
        seenDocumentUris.add(key);
        files.push(doc.fileName);
    }
    return files;
}

export function collectClosedFileTabUris(tabs: readonly OnOpenTab[]): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    for (const tab of tabs) {
        if (tab.input instanceof vscode.TabInputText) {
            uris.push(tab.input.uri);
        }
        if (tab.input instanceof vscode.TabInputTextDiff) {
            uris.push(tab.input.original, tab.input.modified);
        }
    }
    return uris.filter((uri) => uri.scheme === 'file');
}

export function clearPendingSaveDebounce(fileName: string): void {
    const timer = saveDebounceTimers.get(fileName);
    if (timer !== undefined) {
        clearTimeout(timer);
        saveDebounceTimers.delete(fileName);
    }
}

export function clearAllPendingSaveDebounces(): void {
    for (const fileName of [...saveDebounceTimers.keys()]) {
        clearPendingSaveDebounce(fileName);
    }
}

export function handleClosedFileUri(
    uri: vscode.Uri,
    fileName: string,
    seenDocumentUris: Set<string>,
    savedContentHashes: Map<string, string>,
    diagnostics: vscode.DiagnosticCollection
): void {
    seenDocumentUris.delete(uri.toString());
    savedContentHashes.delete(uri.toString());
    clearPendingSaveDebounce(fileName);
    cancelFileRun(fileName);
    clearFileToolDiagnostics(uri.toString());
    clearFileDiagnosticsCache(fileName);
    diagnostics.delete(uri);
}

export function handleClosedDocument(
    doc: OnOpenDocument,
    seenDocumentUris: Set<string>,
    savedContentHashes: Map<string, string>,
    diagnostics: vscode.DiagnosticCollection
): void {
    handleClosedFileUri(doc.uri, doc.fileName, seenDocumentUris, savedContentHashes, diagnostics);
}

export function cleanupExtensionRuntime(deps: DeactivateCleanupDeps = {}): void {
    (deps.clearPendingSaveDebounces ?? clearAllPendingSaveDebounces)();
    (deps.clearRunnerRuntimeState ?? clearRunnerRuntimeState)();
    deps.savedContentHashes?.clear();
    deps.seenOnOpenDocumentUris?.clear();
    deps.diagnostics?.clear();
    deps.diagnostics?.dispose();
    deps.runningStatusBar?.hide();
    deps.runningStatusBar?.dispose();
    deps.actionsStatusBar?.hide();
    deps.actionsStatusBar?.dispose();
    deps.output?.dispose();
    deps.codeLensRefreshEmitter?.dispose();
}

export function deactivate(): void {
    cleanupExtensionRuntime({
        ...deactivateCleanupResources,
        clearPendingSaveDebounces: clearAllPendingSaveDebounces,
        clearRunnerRuntimeState,
        savedContentHashes: lastSavedContentHashes,
    });
    deactivateCleanupResources = undefined;
}

function canRunWorkspaceCommands(showWarning: boolean): boolean {
    if (!vscode.workspace.isTrusted) {
        if (showWarning && !untrustedWorkspaceWarningShown) {
            untrustedWorkspaceWarningShown = true;
            void vscode.window.showWarningMessage('LintRunner: Workspace is not trusted. External tools are disabled.');
        }
        return false;
    }
    return true;
}

function isRunnableDocumentScheme(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' || uri.scheme === 'untitled';
}

function getActiveRunnableEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor !== undefined && isRunnableDocumentScheme(editor.document.uri) ? editor : undefined;
}

function getActiveFileEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.uri.scheme === 'file' ? editor : undefined;
}

function getUntitledDocumentExtension(document: RunnableTextDocument): string {
    const fileExtname = path.extname(document.fileName);
    if (fileExtname !== '') {
        return fileExtname;
    }
    return UNTITLED_LANGUAGE_EXTENSIONS[document.languageId] ?? '.txt';
}

function getDocumentMatchFileName(document: Pick<vscode.TextDocument, 'fileName' | 'languageId' | 'uri'>): string {
    if (document.uri.scheme === 'file') {
        return document.fileName;
    }
    const extension = UNTITLED_LANGUAGE_EXTENSIONS[document.languageId] ?? '.txt';
    return path.join(os.tmpdir(), `lint-runner-untitled${extension}`);
}

function getFullDocumentRange(document: Pick<vscode.TextDocument, 'lineCount'>): vscode.Range {
    return new vscode.Range(0, 0, document.lineCount, 0);
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
}

function hasValidConfig(): boolean {
    return configValidationIssues.errors.length === 0;
}

function getConfigValidationMessage(issues: ConfigValidationIssues): string {
    const errors = issues.errors.slice(0, CONFIG_VALIDATION_PREVIEW_LIMIT).join('\n');
    const suffix = issues.errors.length > CONFIG_VALIDATION_PREVIEW_LIMIT
        ? `\n...and ${issues.errors.length - CONFIG_VALIDATION_PREVIEW_LIMIT} more.`
        : '';
    return `LintRunner config has ${issues.errors.length} error(s):\n${errors}${suffix}`;
}

function showConfigValidationWarning(issues: ConfigValidationIssues, force = false): void {
    if (issues.errors.length === 0 || (configValidationWarningShown && !force)) {
        return;
    }
    configValidationWarningShown = true;
    void vscode.window.showWarningMessage(getConfigValidationMessage(issues));
}

async function refreshConfigValidation(forceWarning = false): Promise<boolean> {
    configValidationIssues = await validateLintRunnerConfig();
    showConfigValidationWarning(configValidationIssues, forceWarning);
    return hasValidConfig();
}

export function getActionsStatusBarState(
    editor: Pick<vscode.TextEditor, 'document'> | undefined,
    isEnabled: typeof isLintRunnerEnabled = isLintRunnerEnabled,
    isConfigValid: typeof hasValidConfig = hasValidConfig,
    getPipelines: typeof getRunnablePipelines = getRunnablePipelines,
    getTools: typeof getRunnableTools = getRunnableTools
): { text: string; tooltip: string } | undefined {
    if (editor === undefined || !isRunnableDocumentScheme(editor.document.uri)) {
        return undefined;
    }
    if (!isEnabled(editor.document.uri) || !isConfigValid()) {
        return undefined;
    }
    const fileName = getDocumentMatchFileName(editor.document);
    const options = { resource: editor.document.uri, languageId: editor.document.languageId };
    const pipelines = getPipelines(fileName, 'manual', options);
    const tools = getTools(fileName, 'manual', options);
    return {
        text: '$(wrench)',
        tooltip: `LintRunner: ${pipelines.length} pipeline(s), ${tools.length} tool(s) for ${vscode.workspace.asRelativePath(fileName)}`,
    };
}

function updateActionsStatusBar(statusBar: vscode.StatusBarItem): void {
    const state = getActionsStatusBarState(getActiveRunnableEditor());
    if (state === undefined) {
        statusBar.hide();
        return;
    }
    statusBar.text = state.text;
    statusBar.tooltip = state.tooltip;
    statusBar.show();
}

function shouldEnableOutputChannel(): boolean {
    return isLoggingEnabled();
}

async function runPipelinesForFile(
    fileName: string,
    trigger: 'manual' | 'onOpen' | 'onSave',
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    pipelines: readonly RunnablePipeline[] = getRunnablePipelines(fileName, trigger),
    options: RunPipelineOptions = {}
): Promise<number> {
    let count = 0;
    for (const pipeline of pipelines) {
        count += await runPipeline(fileName, pipeline, output, statusBar, diagnostics, options);
    }
    return count;
}

export function getRunnablePipelinesForDocument(
    document: Pick<vscode.TextDocument, 'fileName' | 'languageId' | 'uri'>,
    trigger: 'manual' | 'onOpen' | 'onSave' = 'manual'
): RunnablePipeline[] {
    return getRunnablePipelines(getDocumentMatchFileName(document), trigger, {
        resource: document.uri,
        languageId: document.languageId,
    });
}

export function getRunnableToolsForDocument(
    document: Pick<vscode.TextDocument, 'fileName' | 'languageId' | 'uri'>,
    trigger: 'manual' | 'onOpen' | 'onSave' = 'manual'
): RunnableTool[] {
    return getRunnablePipelinesForDocument(document, trigger).flatMap((pipeline) => pipeline.tools);
}

export function runOnOpenPipelinesForVisibleEditors(
    editors: readonly OnOpenEditor[],
    seenDocumentUris: Set<string>,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    tabGroups: readonly OnOpenTabGroup[] = vscode.window.tabGroups.all,
    options: CollectVisibleFileNamesOptions = {},
    onRunPipelines: typeof runPipelinesForFile = runPipelinesForFile
): void {
    const diffDocumentUrisByColumn = collectVisibleDiffDocumentUrisByColumn(tabGroups);
    for (const fileName of collectNewVisibleFileNames(editors, seenDocumentUris, diffDocumentUrisByColumn, options)) {
        void onRunPipelines(fileName, 'onOpen', diagnostics, output, statusBar);
    }
}

function createFailureAwareOutput(output: RunnerOutput, failures: RunnerFailure[]): RunnerOutput {
    return {
        appendLine: (value) => output.appendLine(value),
        reportFailure: (failure) => {
            failures.push(failure);
            output.reportFailure?.(failure);
        },
    };
}

async function delay(ms: number): Promise<void> {
    return void await new Promise((resolve) => setTimeout(resolve, ms));
}

function isExitCodePolicyFailure(message: string): boolean {
    return /\bexit .+ is not in successExitCodes \[.*\]/.test(message);
}

export async function showManualRunFailureWarning(
    failures: readonly RunnerFailure[],
    deps: ManualRunFailureWarningDeps = {}
): Promise<void> {
    if (failures.length === 0) {
        return;
    }
    const message = `LintRunner: ${failures[0].label} failed: ${failures[0].message}`;
    if (isExitCodePolicyFailure(failures[0].message)) {
        const withProgress = deps.withProgress ?? vscode.window.withProgress;
        const wait = deps.delay ?? delay;
        await withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: message,
            },
            async () => {
                await wait(MANUAL_RUN_FAILURE_NOTIFICATION_MS);
            }
        );
        return;
    }
    const showWarningMessage = deps.showWarningMessage ?? vscode.window.showWarningMessage;
    await showWarningMessage(message);
}

export async function runManualTaskWithNotification<T>(
    filePath: string,
    labels: readonly string[],
    task: () => Promise<T>,
    deps: ManualRunNotificationDeps = {}
): Promise<T> {
    const resource = vscode.Uri.file(filePath);
    const isEnabled = deps.isEnabled ?? isManualRunNotificationEnabled;
    if (!isEnabled(resource)) {
        return await task();
    }
    const withProgress = deps.withProgress ?? vscode.window.withProgress;
    const onCancel = deps.onCancel ?? cancelFileRun;
    return await withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: getManualRunNotificationTitle(labels),
            cancellable: true,
        },
        async (_progress, token) => {
            const disposable = token.onCancellationRequested(() => onCancel(filePath));
            try {
                return await task();
            } finally {
                disposable.dispose();
            }
        }
    );
}

function getRunnablePipelineLabels(pipelines: readonly RunnablePipeline[]): string[] {
    return uniqueLabels(pipelines.map((pipeline) => pipeline.label));
}

export async function runManualPipelinesForFile(
    fileName: string,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    pipelines?: readonly RunnablePipeline[],
    options: RunPipelineOptions = {}
): Promise<void> {
    const selectedPipelines = pipelines ?? getRunnablePipelines(fileName, 'manual');
    if (selectedPipelines.length === 0) {
        await vscode.window.showWarningMessage('LintRunner: No matching manual pipeline.');
        return;
    }

    const failures: RunnerFailure[] = [];
    const failureAwareOutput = createFailureAwareOutput(output, failures);
    await runManualTaskWithNotification(fileName, getRunnablePipelineLabels(selectedPipelines), async () =>
        await runPipelinesForFile(fileName, 'manual', diagnostics, failureAwareOutput, statusBar, selectedPipelines, options)
    );
    await showManualRunFailureWarning(failures);
}

async function applyTempFileChangesToDocument(
    document: RunnableTextDocument,
    tempFileName: string,
    applyWorkspaceEdit: typeof vscode.workspace.applyEdit
): Promise<void> {
    const updatedText = await fs.readFile(tempFileName, 'utf8');
    if (updatedText === document.getText()) {
        return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, getFullDocumentRange(document), updatedText);
    await applyWorkspaceEdit(edit);
}

async function runUntitledDocumentPipelines(
    document: RunnableTextDocument,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    pipelines: readonly RunnablePipeline[] | undefined,
    deps: ManualDocumentRunDeps
): Promise<void> {
    const selectedPipelines = pipelines ?? getRunnablePipelinesForDocument(document, 'manual');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-buffer-'));
    const tempFileName = path.join(tempDir, `lint-runner-untitled-${crypto.randomUUID()}${getUntitledDocumentExtension(document)}`);
    try {
        await fs.writeFile(tempFileName, document.getText());
        await (deps.runManualPipelinesForFile ?? runManualPipelinesForFile)(
            tempFileName,
            diagnostics,
            output,
            statusBar,
            selectedPipelines,
            { diagnosticUri: document.uri }
        );
        await applyTempFileChangesToDocument(document, tempFileName, deps.applyWorkspaceEdit ?? vscode.workspace.applyEdit);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

export async function runManualPipelinesForDocument(
    document: RunnableTextDocument,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    pipelines?: readonly RunnablePipeline[],
    deps: ManualDocumentRunDeps = {}
): Promise<void> {
    if (document.uri.scheme === 'file') {
        await (deps.runManualPipelinesForFile ?? runManualPipelinesForFile)(
            document.fileName,
            diagnostics,
            output,
            statusBar,
            pipelines
        );
        return;
    }
    await runUntitledDocumentPipelines(document, diagnostics, output, statusBar, pipelines, deps);
}

export async function runManualToolForFile(
    fileName: string,
    tool: RunnableTool,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem
): Promise<void> {
    const pipeline: RunnablePipeline = {
        label: tool.label,
        description: tool.description,
        detail: tool.detail,
        target: { name: tool.targetName },
        pipelineName: 'manual',
        pipeline: { strategy: 'sequence', tools: [tool.toolName] },
        tools: [tool],
    };
    await runManualPipelinesForFile(fileName, diagnostics, output, statusBar, [pipeline]);
}

export async function runManualToolForDocument(
    document: RunnableTextDocument,
    tool: RunnableTool,
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem
): Promise<void> {
    const pipeline: RunnablePipeline = {
        label: tool.label,
        description: tool.description,
        detail: tool.detail,
        target: { name: tool.targetName },
        pipelineName: 'manual',
        pipeline: { strategy: 'sequence', tools: [tool.toolName] },
        tools: [tool],
    };
    await runManualPipelinesForDocument(document, diagnostics, output, statusBar, [pipeline]);
}

export function createManualCodeActions(
    documentUri: vscode.Uri,
    _pipelines: readonly RunnablePipeline[],
    tools: readonly RunnableTool[]
): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const tool of tools) {
        const title = `Run: ${tool.label}`;
        const action = new vscode.CodeAction(title, manualToolCodeActionKind);
        action.command = { title, command: 'lintRunner.runManualToolCodeAction', arguments: [documentUri, tool] };
        actions.push(action);
    }
    return actions;
}

export function createManualCodeLenses(
    documentUri: vscode.Uri,
    pipelines: readonly RunnablePipeline[],
    tools: readonly RunnableTool[]
): vscode.CodeLens[] {
    const range = new vscode.Range(0, 0, 0, 0);
    return createManualCodeActions(documentUri, pipelines, tools).map((action) =>
        new vscode.CodeLens(range, action.command)
    );
}

async function openActionsMenu(
    diagnostics: vscode.DiagnosticCollection,
    output: RunnerOutput,
    runningStatusBar: vscode.StatusBarItem
): Promise<void> {
    const editor = getActiveRunnableEditor();
    if (editor === undefined || !canRunWorkspaceCommands(true)) {
        return;
    }
    const pipelines = getRunnablePipelinesForDocument(editor.document, 'manual');
    const tools = getRunnableToolsForDocument(editor.document, 'manual');
    if (pipelines.length === 0 && tools.length === 0) {
        vscode.window.showWarningMessage('LintRunner: No matching pipeline or tool.');
        return;
    }

    const items: ActionQuickPickItem[] = [
        ...pipelines.map((pipeline) => ({
            label: `$(play) ${pipeline.label}`,
            description: pipeline.description,
            detail: pipeline.detail,
            action: async () => await runManualPipelinesForDocument(editor.document, diagnostics, output, runningStatusBar, [pipeline]),
        })),
        ...tools.map((tool) => ({
            label: `$(wrench) ${tool.label}`,
            description: tool.description,
            detail: tool.detail,
            action: async () => await runManualToolForDocument(editor.document, tool, diagnostics, output, runningStatusBar),
        })),
    ];
    const selectedItem = await vscode.window.showQuickPick(items, {
        placeHolder: 'Run pipeline or tool for active file',
        title: 'LintRunner Actions',
    });
    await selectedItem?.action?.();
}

export async function runDoctorWithNotification(
    resource?: vscode.Uri,
    deps: DoctorNotificationDeps = {}
): Promise<void> {
    const getStatuses = deps.getStatuses ?? getDoctorToolStatuses;
    const withProgress = deps.withProgress ?? vscode.window.withProgress;
    const openTextDocument = deps.openTextDocument ?? vscode.workspace.openTextDocument;
    const showTextDocument = deps.showTextDocument ?? vscode.window.showTextDocument;
    const statuses = await withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'LintRunner: Doctor', cancellable: false },
        async () => await getStatuses(resource)
    );
    const document = await openTextDocument({
        content: `# LintRunner Doctor\n\n${formatDoctorTable(statuses)}\n`,
        language: 'markdown',
    });
    await showTextDocument(document, { preview: true });
}

export async function openBundledExamples(
    extensionUri: vscode.Uri,
    deps: OpenBundledExamplesDeps = {}
): Promise<void> {
    const openTextDocument = deps.openTextDocument ?? vscode.workspace.openTextDocument;
    const showTextDocument = deps.showTextDocument ?? vscode.window.showTextDocument;
    const document = await openTextDocument(vscode.Uri.joinPath(extensionUri, 'docs', 'examples.md'));
    await showTextDocument(document, { preview: true });
}

async function inspectCurrentFile(): Promise<void> {
    const editor = getActiveRunnableEditor();
    if (editor === undefined) {
        vscode.window.showWarningMessage('LintRunner: No active file editor.');
        return;
    }
    const fileName = getDocumentMatchFileName(editor.document);
    const pipelines = getRunnablePipelinesForDocument(editor.document, 'manual');
    const tools = getRunnableToolsForDocument(editor.document, 'manual');
    const lines = [
        '# LintRunner Inspect Current File',
        '',
        `File: ${fileName}`,
        '',
        '## Manual Pipelines',
        ...(pipelines.length === 0 ? ['- none'] : pipelines.map((pipeline) => `- ${pipeline.label}: ${pipeline.detail}`)),
        '',
        '## Manual Tools',
        ...(tools.length === 0 ? ['- none'] : tools.map((tool) => `- ${tool.label}: ${tool.detail}`)),
    ];
    const document = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
    await vscode.window.showTextDocument(document, { preview: true });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner');
    const output = new OutputChannelManager();
    output.sync(shouldEnableOutputChannel());
    const runningStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    runningStatusBar.name = 'LintRunner';
    runningStatusBar.command = 'lintRunner.stop';
    const actionsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    actionsStatusBar.name = 'LintRunner Actions';
    actionsStatusBar.command = 'lintRunner.actions';
    const codeLensRefreshEmitter = new vscode.EventEmitter<void>();
    const seenOnOpenDocumentUris = new Set<string>();
    context.subscriptions.push(diagnostics, output, runningStatusBar, actionsStatusBar, codeLensRefreshEmitter);
    deactivateCleanupResources = { seenOnOpenDocumentUris, diagnostics, runningStatusBar, actionsStatusBar, output, codeLensRefreshEmitter };

    let lintRunnerEnabled = isLintRunnerEnabled();
    let configValid = await refreshConfigValidation();
    updateActionsStatusBar(actionsStatusBar);
    codeLensRefreshEmitter.fire();

    if (canRunWorkspaceCommands(false)) {
        runOnOpenPipelinesForVisibleEditors(vscode.window.visibleTextEditors, seenOnOpenDocumentUris, diagnostics, output, runningStatusBar);
    } else {
        collectNewVisibleFileNames(
            vscode.window.visibleTextEditors,
            seenOnOpenDocumentUris,
            collectVisibleDiffDocumentUrisByColumn(vscode.window.tabGroups.all)
        );
    }

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], {
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
                return createManualCodeLenses(
                    document.uri,
                    getRunnablePipelinesForDocument(document, 'manual'),
                    getRunnableToolsForDocument(document, 'manual')
                );
            },
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            [{ scheme: 'file' }, { scheme: 'untitled' }],
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
                    return createManualCodeActions(
                        document.uri,
                        getRunnablePipelinesForDocument(document, 'manual'),
                        getRunnableToolsForDocument(document, 'manual')
                    );
                },
            },
            { providedCodeActionKinds: [manualPipelineCodeActionKind, manualToolCodeActionKind] }
        )
    );

    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            if (canRunWorkspaceCommands(false)) {
                runOnOpenPipelinesForVisibleEditors(editors, seenOnOpenDocumentUris, diagnostics, output, runningStatusBar);
            }
            updateActionsStatusBar(actionsStatusBar);
        }),
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            if (!canRunWorkspaceCommands(false)) {
                return;
            }
            runOnOpenPipelinesForVisibleEditors(
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
        }),
        { dispose: clearAllPendingSaveDebounces },
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (!canRunWorkspaceCommands(false)) {
                return;
            }
            const hash = computeContentHash(doc.getText());
            if (!isContentChanged(documentKey(doc), hash, lastSavedContentHashes)) {
                return;
            }
            clearPendingSaveDebounce(doc.fileName);
            const debounceMs = vscode.workspace.getConfiguration('lintRunner', doc.uri).get<number>('debounceMs') ?? 0;
            const doRun = async (): Promise<void> => {
                saveDebounceTimers.delete(doc.fileName);
                await runPipelinesForFile(doc.fileName, 'onSave', diagnostics, output, runningStatusBar);
                updateActionsStatusBar(actionsStatusBar);
            };
            if (debounceMs <= 0) {
                await doRun();
            } else {
                saveDebounceTimers.set(doc.fileName, setTimeout(() => { doRun().catch(() => undefined); }, debounceMs));
            }
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            handleClosedDocument(doc, seenOnOpenDocumentUris, lastSavedContentHashes, diagnostics);
            updateActionsStatusBar(actionsStatusBar);
        }),
        vscode.window.tabGroups.onDidChangeTabs((event) => {
            for (const uri of collectClosedFileTabUris(event.closed)) {
                handleClosedFileUri(uri, uri.fsPath, seenOnOpenDocumentUris, lastSavedContentHashes, diagnostics);
            }
            updateActionsStatusBar(actionsStatusBar);
        }),
        vscode.window.onDidChangeActiveTextEditor(() => updateActionsStatusBar(actionsStatusBar)),
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (!event.affectsConfiguration('lintRunner')) {
                return;
            }
            const wasEnabled = lintRunnerEnabled;
            const wasConfigValid = configValid;
            resetCommandEnv();
            clearDiagnosticsCache();
            clearAllFileToolDiagnostics();
            clearAllPendingSaveDebounces();
            cancelAllFileRuns();
            diagnostics.clear();
            runningStatusBar.hide();
            output.sync(shouldEnableOutputChannel());
            updateActionsStatusBar(actionsStatusBar);
            codeLensRefreshEmitter.fire();
            lintRunnerEnabled = isLintRunnerEnabled();
            configValid = await refreshConfigValidation();
            if ((!wasEnabled || !wasConfigValid) && lintRunnerEnabled && configValid && vscode.workspace.isTrusted) {
                runOnOpenPipelinesForVisibleEditors(
                    vscode.window.visibleTextEditors,
                    seenOnOpenDocumentUris,
                    diagnostics,
                    output,
                    runningStatusBar,
                    vscode.window.tabGroups.all,
                    { includeSeen: true }
                );
            }
        }),
        vscode.commands.registerCommand('lintRunner.openExamples', async () => await openBundledExamples(context.extensionUri)),
        vscode.commands.registerCommand('lintRunner.doctor', async () => {
            if (canRunWorkspaceCommands(true)) {
                await runDoctorWithNotification(vscode.window.activeTextEditor?.document.uri);
            }
        }),
        vscode.commands.registerCommand('lintRunner.runPipeline', async () => {
            const editor = getActiveRunnableEditor();
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active file editor.');
                return;
            }
            if (!canRunWorkspaceCommands(true)) {
                return;
            }
            const pipelines = getRunnablePipelinesForDocument(editor.document, 'manual');
            const selected = pipelines.length === 1
                ? pipelines[0]
                : await vscode.window.showQuickPick(pipelines, { title: 'LintRunner: Run Pipeline' });
            if (selected !== undefined) {
                await runManualPipelinesForDocument(editor.document, diagnostics, output, runningStatusBar, [selected]);
            }
        }),
        vscode.commands.registerCommand('lintRunner.runTool', async () => {
            const editor = getActiveRunnableEditor();
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active file editor.');
                return;
            }
            if (!canRunWorkspaceCommands(true)) {
                return;
            }
            const tools = getRunnableToolsForDocument(editor.document, 'manual');
            const selected = tools.length === 1
                ? tools[0]
                : await vscode.window.showQuickPick(tools, { title: 'LintRunner: Run Tool' });
            if (selected !== undefined) {
                await runManualToolForDocument(editor.document, selected, diagnostics, output, runningStatusBar);
            }
        }),
        vscode.commands.registerCommand('lintRunner.inspectCurrentFile', inspectCurrentFile),
        vscode.commands.registerCommand('lintRunner.runManualPipelineCodeAction', async (uri: vscode.Uri, pipeline: RunnablePipeline) => {
            if (canRunWorkspaceCommands(true)) {
                const document = findOpenDocument(uri);
                if (document !== undefined) {
                    await runManualPipelinesForDocument(document, diagnostics, output, runningStatusBar, [pipeline]);
                } else {
                    await runManualPipelinesForFile(uri.fsPath, diagnostics, output, runningStatusBar, [pipeline]);
                }
            }
        }),
        vscode.commands.registerCommand('lintRunner.runManualToolCodeAction', async (uri: vscode.Uri, tool: RunnableTool) => {
            if (canRunWorkspaceCommands(true)) {
                const document = findOpenDocument(uri);
                if (document !== undefined) {
                    await runManualToolForDocument(document, tool, diagnostics, output, runningStatusBar);
                } else {
                    await runManualToolForFile(uri.fsPath, tool, diagnostics, output, runningStatusBar);
                }
            }
        }),
        vscode.commands.registerCommand('lintRunner.stop', () => cancelAllFileRuns()),
        vscode.commands.registerCommand('lintRunner.clearDiagnostics', () => {
            if (!canRunWorkspaceCommands(true)) {
                return;
            }
            const editor = getActiveFileEditor();
            if (editor !== undefined) {
                const uri = editor.document.uri;
                diagnostics.delete(uri);
                clearFileToolDiagnostics(uri.toString());
                clearFileDiagnosticsCache(uri.fsPath);
            } else {
                diagnostics.clear();
                clearAllFileToolDiagnostics();
                clearDiagnosticsCache();
            }
        }),
        vscode.commands.registerCommand('lintRunner.actions', async () => await openActionsMenu(diagnostics, output, runningStatusBar))
    );
}
