import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { diagnosticHasExplicitColumn } from './parser/diagnostic.js';
import { parseRegexOutput, type RegexParserConfig } from './parser/regexParser.js';

const runningLinters = new Map<string, number>();
const activeRunIds = new Map<string, number>();
let nextRunId = 0;

// Per-linter diagnostics store: file URI string -> linter name -> diagnostics.
// Allows multiple linters' results to coexist without overwriting each other.
const fileLinterDiagnostics = new Map<string, Map<string, vscode.Diagnostic[]>>();

function getOrCreateLinterMap(uriString: string): Map<string, vscode.Diagnostic[]> {
    let map = fileLinterDiagnostics.get(uriString);
    if (map === undefined) {
        map = new Map();
        fileLinterDiagnostics.set(uriString, map);
    }
    return map;
}

function republishMergedDiagnostics(
    uri: vscode.Uri,
    linterMap: Map<string, vscode.Diagnostic[]>,
    diagnostics: vscode.DiagnosticCollection
): void {
    const merged: vscode.Diagnostic[] = [];
    for (const diags of linterMap.values()) {
        merged.push(...diags);
    }
    if (merged.length === 0) {
        diagnostics.delete(uri);
    } else {
        diagnostics.set(uri, merged);
    }
}

export function clearFileLinterDiagnostics(uriString: string): void {
    fileLinterDiagnostics.delete(uriString);
}

const activeFileProcesses = new Map<string, Set<cp.ChildProcess>>();

function registerProcess(filePath: string, proc: cp.ChildProcess): void {
    let procs = activeFileProcesses.get(filePath);
    if (procs === undefined) {
        procs = new Set();
        activeFileProcesses.set(filePath, procs);
    }
    procs.add(proc);
}

function unregisterProcess(filePath: string, proc: cp.ChildProcess): void {
    const procs = activeFileProcesses.get(filePath);
    if (procs === undefined) {
        return;
    }
    procs.delete(proc);
    if (procs.size === 0) {
        activeFileProcesses.delete(filePath);
    }
}

function terminateProcessTree(proc: cp.ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (proc.pid !== undefined && process.platform !== 'win32') {
        try {
            process.kill(-proc.pid, signal);
            return;
        } catch {
            // Fall back to killing the direct child below.
        }
    }

    proc.kill(signal);
}

function killFileProcesses(filePath: string): void {
    const procs = activeFileProcesses.get(filePath);
    if (procs === undefined) {
        return;
    }
    const procsCopy = Array.from(procs);
    procs.clear();
    activeFileProcesses.delete(filePath);
    for (const proc of procsCopy) {
        terminateProcessTree(proc);
    }
}

function startFileRun(filePath: string): number {
    const runId = nextRunId++;
    activeRunIds.set(filePath, runId);
    killFileProcesses(filePath);
    return runId;
}

function isActiveFileRun(filePath: string, runId: number): boolean {
    return activeRunIds.get(filePath) === runId;
}

function finishFileRun(filePath: string, runId: number): void {
    if (isActiveFileRun(filePath, runId)) {
        activeRunIds.delete(filePath);
    }
}

export function cancelFileRun(filePath: string): void {
    activeRunIds.delete(filePath);
    killFileProcesses(filePath);
}

interface LinterCacheEntry {
    mtime: number;
    size: number;
    diagnostics: vscode.Diagnostic[];
}
const linterDiagnosticsCache = new Map<string, LinterCacheEntry>();

function linterCacheKey(filePath: string, linterName: string): string {
    return `${filePath}\x00${linterName}`;
}

export function clearDiagnosticsCache(): void {
    linterDiagnosticsCache.clear();
}

const SHELL_ENV_TIMEOUT_MS = 3000;
const SHELL_PATH_PREFIX = 'LINT_RUNNER_PATH=';

type RunMode = 'manual' | 'onSave' | 'onOpen';
type FixerRunMode = Extract<RunMode, 'manual' | 'onSave'>;
type DiagnosticsHandler = (linterName: string, diagnostics: vscode.Diagnostic[]) => void;
let commandEnvPromise: Promise<NodeJS.ProcessEnv> | undefined;

export interface CommandConfig {
    name?: string;
    command: string;
    args: string[];
}

export interface FixerConfig extends CommandConfig {
    name: string;
    run?: FixerRunMode;
    enabled?: boolean;
}

export type { RegexParserConfig };

export interface TargetLinterConfig {
    name: string;
    command: string;
    args: string[];
    parser: RegexParserConfig;
    run?: RunMode;
    enabled?: boolean;
    preCommands?: CommandConfig[];
    timeout?: number;
    maxFileSize?: number;
}

export interface LinterConfig extends TargetLinterConfig {
    filePatterns?: string[];
    languages?: string[];
    run: RunMode;
}

export interface TargetConfig {
    name: string;
    filePatterns?: string[];
    languages?: string[];
    run?: RunMode;
    preCommands?: CommandConfig[];
    linters?: TargetLinterConfig[];
    fixers?: FixerConfig[];
}

export interface LinterPatch {
    name: string;
    command?: string;
    args?: string[];
    parser?: RegexParserConfig;
    run?: RunMode;
    enabled?: boolean;
    preCommands?: CommandConfig[];
    timeout?: number;
    maxFileSize?: number;
}

export interface FixerPatch {
    name: string;
    command?: string;
    args?: string[];
    run?: FixerRunMode;
    enabled?: boolean;
}

export interface TargetPatch {
    name: string;
    filePatterns?: string[];
    languages?: string[];
    run?: RunMode;
    preCommands?: CommandConfig[];
    linters?: LinterPatch[];
    fixers?: FixerPatch[];
}

export interface ResolvedTargetConfig {
    name: string;
    filePatterns: string[];
    languages: string[];
    preCommands: CommandConfig[];
    linters: LinterConfig[];
    fixers: FixerConfig[];
}

export interface RunnableFixer {
    label: string;
    description: string;
    detail: string;
    targetName: string;
    fixer: FixerConfig;
}

export interface RunnableLinter {
    label: string;
    description: string;
    detail: string;
    target: ResolvedTargetConfig;
    linter: LinterConfig;
}

export interface CommandResult {
    code: number | null;
    stdout: string;
    stderr: string;
    error?: string;
}

function globPatternToRegexBody(pattern: string): string {
    let result = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*' && pattern[i + 1] === '*') {
            result += '.*';
            i++;
            if (pattern[i + 1] === '/') {
                i++;
            }
        } else if (c === '*') {
            result += '[^/]*';
        } else if (c === '?') {
            result += '[^/]';
        } else if (c === '[') {
            // Handle bracket expressions like [abc], [a-z], [!abc]
            let j = i + 1;
            // Per POSIX glob spec, ] and ^ at the very start (or right after !)
            // are treated as literal characters, not as end-of-class or negation.
            // ^ is accepted here as an alias for ! (same as many shells/tools).
            if (j < pattern.length && (pattern[j] === '!' || pattern[j] === '^')) {
                j++;
            }
            if (j < pattern.length && pattern[j] === ']') {
                j++;
            }
            while (j < pattern.length && pattern[j] !== ']') {
                j++;
            }
            if (j < pattern.length) {
                let inner = pattern.slice(i + 1, j);
                // Convert glob negation [!...] to regex negation [^...]
                if (inner.startsWith('!')) {
                    inner = `^${inner.slice(1)}`;
                }
                result += `[${inner}]`;
                i = j;
            } else {
                // No closing ], treat [ as a literal character
                result += '\\[';
            }
        } else if (c === '{') {
            let j = i + 1;
            let depth = 1;
            while (j < pattern.length && depth > 0) {
                if (pattern[j] === '{') { depth++; }
                else if (pattern[j] === '}') { depth--; }
                j++;
            }
            if (depth === 0) {
                const inner = pattern.slice(i + 1, j - 1);
                const alternatives: string[] = [];
                let start = 0;
                let innerDepth = 0;
                for (let k = 0; k < inner.length; k++) {
                    if (inner[k] === '{') { innerDepth++; }
                    else if (inner[k] === '}') { innerDepth--; }
                    else if (inner[k] === ',' && innerDepth === 0) {
                        alternatives.push(inner.slice(start, k));
                        start = k + 1;
                    }
                }
                alternatives.push(inner.slice(start));
                result += `(${alternatives.map(globPatternToRegexBody).join('|')})`;
                i = j - 1;
            } else {
                result += '\\{';
            }
        } else if (/[.+^$}()|[\]\\]/.test(c)) {
            result += `\\${c}`;
        } else {
            result += c;
        }
    }
    return result;
}

function globToRegex(pattern: string): RegExp {
    return new RegExp(`^${globPatternToRegexBody(pattern)}$`);
}

function normalizePath(value: string): string {
    return value.split(path.sep).join('/');
}

function collectPathMatchCandidates(filePath: string): string[] {
    const candidates = new Set<string>([path.basename(filePath)]);

    const addPathCandidates = (value: string): void => {
        const normalizedValue = normalizePath(value);
        if (normalizedValue.length === 0) {
            return;
        }

        candidates.add(normalizedValue);

        const trimmedValue = normalizedValue.replace(/^\/+/, '');
        if (trimmedValue.length === 0) {
            return;
        }

        const parts = trimmedValue.split('/').filter((part) => part.length > 0);
        for (let i = 0; i < parts.length; i++) {
            candidates.add(parts.slice(i).join('/'));
        }
    };

    addPathCandidates(vscode.workspace.asRelativePath(filePath, false));
    addPathCandidates(filePath);

    return [...candidates];
}

function matchesPatterns(filePath: string, patterns: string[]): boolean {
    const candidates = collectPathMatchCandidates(filePath);

    return patterns.some((pattern) => {
        const re = globToRegex(pattern);
        return candidates.some((candidate) => re.test(candidate));
    });
}

function getDocumentLanguageId(filePath: string): string | undefined {
    return vscode.workspace.textDocuments.find(
        (doc) => doc.uri.scheme === 'file' && doc.fileName === filePath
    )?.languageId;
}

function matchesTarget(filePath: string, target: ResolvedTargetConfig): boolean {
    // Language is always required.
    if (target.languages.length === 0) {
        return false;
    }
    const languageId = getDocumentLanguageId(filePath);
    if (languageId === undefined || !target.languages.includes(languageId)) {
        return false;
    }
    // filePatterns is an optional additional filter on top of the language match.
    if (target.filePatterns.length > 0) {
        return matchesPatterns(filePath, target.filePatterns);
    }
    return true;
}

function normalizeTargetConfig(target: TargetConfig): ResolvedTargetConfig {
    const targetRun = target.run ?? 'onSave';
    const linters = (target.linters ?? []).map((linter) => ({
        ...linter,
        filePatterns: target.filePatterns ?? [],
        languages: target.languages ?? [],
        run: linter.run ?? targetRun,
    }));

    return {
        name: target.name,
        filePatterns: target.filePatterns ?? [],
        languages: target.languages ?? [],
        preCommands: target.preCommands ?? [],
        linters,
        fixers: target.fixers ?? [],
    };
}

function legacyLinterToTarget(linter: LinterConfig): ResolvedTargetConfig {
    return {
        name: linter.name,
        filePatterns: linter.filePatterns ?? [],
        languages: linter.languages ?? [],
        preCommands: [],
        linters: [linter],
        fixers: [],
    };
}

export function resolveConfiguredTargets(
    targets: TargetConfig[],
    legacyLinters: LinterConfig[]
): ResolvedTargetConfig[] {
    return [...targets.map(normalizeTargetConfig), ...legacyLinters.map(legacyLinterToTarget)];
}

function cloneCommandConfig(command: CommandConfig): CommandConfig {
    return {
        ...command,
        args: [...command.args],
    };
}

function cloneLinterConfig(linter: TargetLinterConfig): TargetLinterConfig {
    return {
        ...linter,
        args: [...linter.args],
        parser: { ...linter.parser },
        preCommands: linter.preCommands?.map(cloneCommandConfig),
    };
}

function cloneFixerConfig(fixer: FixerConfig): FixerConfig {
    return {
        ...fixer,
        args: [...fixer.args],
    };
}

function isCompleteLinterConfig(linter: LinterPatch): linter is TargetLinterConfig {
    return (
        linter.command !== undefined &&
        linter.args !== undefined &&
        linter.parser?.pattern !== undefined
    );
}

function isCompleteFixerConfig(fixer: FixerPatch): fixer is FixerConfig {
    return fixer.command !== undefined && fixer.args !== undefined;
}

function isCompleteTargetConfig(target: TargetPatch): target is TargetConfig {
    return target.languages !== undefined && target.languages.length > 0;
}

function applyLinterPatch(result: TargetLinterConfig[], patch: LinterPatch): void {
    const idx = result.findIndex((linter) => linter.name === patch.name);
    if (idx >= 0) {
        result[idx] = {
            ...result[idx],
            ...patch,
            args: patch.args !== undefined ? [...patch.args] : result[idx].args,
            parser:
                patch.parser !== undefined
                    ? { ...result[idx].parser, ...patch.parser }
                    : result[idx].parser,
            preCommands:
                patch.preCommands !== undefined
                    ? patch.preCommands.map(cloneCommandConfig)
                    : result[idx].preCommands,
        };
        return;
    }

    if (!isCompleteLinterConfig(patch)) {
        return;
    }

    result.push(cloneLinterConfig(patch));
}

function mergeLinters(
    globalLinters: TargetLinterConfig[],
    patches: LinterPatch[]
): TargetLinterConfig[] {
    const result: TargetLinterConfig[] = [];

    for (const linter of globalLinters) {
        applyLinterPatch(result, linter);
    }
    for (const patch of patches) {
        applyLinterPatch(result, patch);
    }

    return result;
}

function applyFixerPatch(result: FixerConfig[], patch: FixerPatch): void {
    const idx = result.findIndex((fixer) => fixer.name === patch.name);
    if (idx >= 0) {
        result[idx] = {
            ...result[idx],
            ...patch,
            args: patch.args !== undefined ? [...patch.args] : result[idx].args,
        };
        return;
    }

    if (!isCompleteFixerConfig(patch)) {
        return;
    }

    result.push(cloneFixerConfig(patch));
}

function mergeFixers(
    globalFixers: FixerConfig[],
    patches: FixerPatch[]
): FixerConfig[] {
    const result: FixerConfig[] = [];

    for (const fixer of globalFixers) {
        applyFixerPatch(result, fixer);
    }
    for (const patch of patches) {
        applyFixerPatch(result, patch);
    }

    return result;
}

function applyTargetPatch(result: TargetConfig[], patch: TargetPatch): void {
    const idx = result.findIndex((target) => target.name === patch.name);
    if (idx >= 0) {
        const existing = result[idx];
        result[idx] = {
            ...existing,
            ...patch,
            filePatterns:
                patch.filePatterns !== undefined ? [...patch.filePatterns] : existing.filePatterns,
            languages: patch.languages !== undefined ? [...patch.languages] : existing.languages,
            preCommands:
                patch.preCommands !== undefined
                    ? patch.preCommands.map(cloneCommandConfig)
                    : existing.preCommands,
            linters:
                patch.linters !== undefined
                    ? mergeLinters(existing.linters ?? [], patch.linters)
                    : existing.linters,
            fixers:
                patch.fixers !== undefined
                    ? mergeFixers(existing.fixers ?? [], patch.fixers)
                    : existing.fixers,
        };
        return;
    }

    if (!isCompleteTargetConfig(patch)) {
        return;
    }

    result.push({
        ...patch,
        filePatterns: patch.filePatterns !== undefined ? [...patch.filePatterns] : undefined,
        languages: patch.languages !== undefined ? [...patch.languages] : undefined,
        preCommands: patch.preCommands?.map(cloneCommandConfig),
        linters: patch.linters !== undefined ? mergeLinters([], patch.linters) : undefined,
        fixers: patch.fixers !== undefined ? mergeFixers([], patch.fixers) : undefined,
    });
}

export function mergeConfiguredTargets(
    globalTargets: TargetConfig[],
    patches: TargetPatch[]
): TargetConfig[] {
    const result: TargetConfig[] = [];

    for (const target of globalTargets) {
        applyTargetPatch(result, target);
    }
    for (const patch of patches) {
        applyTargetPatch(result, patch);
    }

    return result;
}

function getScopedTargets(filePath: string): TargetConfig[] {
    const config = vscode.workspace.getConfiguration('lintRunner', vscode.Uri.file(filePath));
    const inspectedTargets = config.inspect<TargetPatch[]>('targets');
    const mergedGlobalTargets = mergeConfiguredTargets([], inspectedTargets?.globalValue ?? []);
    const mergedWorkspaceTargets = mergeConfiguredTargets(
        mergedGlobalTargets,
        inspectedTargets?.workspaceValue ?? []
    );

    return mergeConfiguredTargets(
        mergedWorkspaceTargets,
        inspectedTargets?.workspaceFolderValue ?? []
    );
}

function getConfiguredTargets(filePath: string): ResolvedTargetConfig[] {
    const config = vscode.workspace.getConfiguration('lintRunner');
    const targets = getScopedTargets(filePath);
    const legacyLinters = config.get<LinterConfig[]>('linters') ?? [];

    return resolveConfiguredTargets(targets, legacyLinters);
}

function expandHome(value: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return value.replace(/(^|=)~(?=\/|$)/, `$1${home}`);
}

function getPathKey(env: NodeJS.ProcessEnv): string {
    return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

function mergePathValues(...values: string[]): string {
    const entries = values
        .flatMap((value) => value.split(path.delimiter))
        .filter((value) => value !== '');

    return [...new Set(entries)].join(path.delimiter);
}

export function buildCommandEnv(shellPath?: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (shellPath === undefined || shellPath === '') {
        return env;
    }

    const pathKey = getPathKey(env);
    env[pathKey] = mergePathValues(shellPath, env[pathKey] ?? '');
    return env;
}

function getShellPathCommand(shell: string): string {
    return path.basename(shell) === 'fish'
        ? `printf '${SHELL_PATH_PREFIX}%s\\n' (string join ${path.delimiter} $PATH)`
        : `printf '${SHELL_PATH_PREFIX}%s\\n' "$PATH"`;
}

function parseShellPath(stdout: string): string | undefined {
    const lines = stdout.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith(SHELL_PATH_PREFIX)) {
            return lines[i].slice(SHELL_PATH_PREFIX.length);
        }
    }

    return undefined;
}

function getLoginShell(): string | undefined {
    return process.env.SHELL ?? os.userInfo().shell ?? undefined;
}

function resolveShellPath(): Promise<string | undefined> {
    const shell = getLoginShell();
    if (shell === undefined || process.platform === 'win32') {
        return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
        const proc = cp.spawn(shell, ['-lc', getShellPathCommand(shell)]);
        let stdout = '';
        let done = false;

        const timer = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            proc.kill();
            resolve(undefined);
        }, SHELL_ENV_TIMEOUT_MS);

        proc.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        proc.on('error', () => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            resolve(undefined);
        });

        proc.on('close', () => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            resolve(parseShellPath(stdout));
        });
    });
}

function getCommandEnv(): Promise<NodeJS.ProcessEnv> {
    commandEnvPromise ??= resolveShellPath().then(buildCommandEnv);
    return commandEnvPromise;
}

export function resetCommandEnv(): void {
    commandEnvPromise = undefined;
}

export function shouldRunLinter(linter: LinterConfig, trigger: RunMode): boolean {
    return (
        linter.enabled !== false &&
        (trigger === 'manual' ||
            linter.run === trigger ||
            (trigger === 'onSave' && linter.run === 'onOpen'))
    );
}

export function shouldProcessLinterFile(fileSize: number, maxFileSize?: number): boolean {
    return maxFileSize === undefined || fileSize <= maxFileSize;
}

function shouldStatFile(linter: LinterConfig, trigger: RunMode): boolean {
    return linter.maxFileSize !== undefined || trigger !== 'manual';
}

interface CommandTemplateValues {
    file: string;
    workspaceFolder: string;
    relativeFile: string;
    fileDirname: string;
    fileBasename: string;
    fileBasenameNoExtension: string;
    fileExtname: string;
}

function buildCommandTemplateValues(filePath: string): CommandTemplateValues {
    const workspaceFolder = resolveWorkingDirectory(filePath) ?? '';
    const fileExtname = path.extname(filePath);
    return {
        file: filePath,
        workspaceFolder,
        relativeFile: workspaceFolder === '' ? filePath : path.relative(workspaceFolder, filePath),
        fileDirname: path.dirname(filePath),
        fileBasename: path.basename(filePath),
        fileBasenameNoExtension: path.basename(filePath, fileExtname),
        fileExtname,
    };
}

export function applyCommandTemplate(value: string, filePath: string): string {
    const values = buildCommandTemplateValues(filePath);
    return value.replace(/\$\{(\w+)\}/g, (match, key: string) => {
        if (Object.hasOwn(values, key)) {
            return values[key as keyof CommandTemplateValues];
        }

        return match;
    });
}

function buildArgs(args: string[], filePath: string): string[] {
    return args.map((arg) => expandHome(applyCommandTemplate(arg, filePath)));
}

function formatCommandPart(value: string): string {
    return /\s/.test(value) ? JSON.stringify(value) : value;
}

function formatCommand(command: string, args: string[]): string {
    return [command, ...args].map(formatCommandPart).join(' ');
}

function formatCommandStatus(result: CommandResult): string {
    if (result.error !== undefined) {
        return `failed: ${result.error}`;
    }

    return result.code === 0 ? 'ok' : `exit ${result.code ?? 'null'}`;
}

function formatRunningLinterName(name: string, count: number): string {
    return count > 1 ? `${name} x${count}` : name;
}

function updateStatusBar(statusBar: vscode.StatusBarItem): void {
    const names = [...runningLinters.entries()].map(([name, count]) =>
        formatRunningLinterName(name, count)
    );

    if (names.length === 0) {
        statusBar.hide();
        return;
    }

    statusBar.text = `$(sync~spin) LintRunner: ${names.join(', ')}`;
    statusBar.tooltip = `Running linters: ${names.join(', ')}`;
    statusBar.show();
}

function startLinterStatus(name: string, statusBar: vscode.StatusBarItem): void {
    runningLinters.set(name, (runningLinters.get(name) ?? 0) + 1);
    updateStatusBar(statusBar);
}

function stopLinterStatus(name: string, statusBar: vscode.StatusBarItem): void {
    const count = runningLinters.get(name) ?? 0;
    if (count <= 1) {
        runningLinters.delete(name);
    } else {
        runningLinters.set(name, count - 1);
    }
    updateStatusBar(statusBar);
}

const TIMEOUT_MS = 30_000;

function resolveWorkingDirectory(filePath: string): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    return folder?.uri.fsPath;
}

async function runCommand(
    label: string,
    commandConfig: CommandConfig,
    filePath: string,
    output: vscode.OutputChannel,
    shouldContinue: () => boolean = () => true,
    timeoutMs: number = TIMEOUT_MS
): Promise<CommandResult> {
    if (!vscode.workspace.isTrusted) {
        output.appendLine(`[${label}] skipped: workspace is not trusted`);
        return Promise.resolve({
            code: null,
            stdout: '',
            stderr: '',
            error: 'workspace is not trusted',
        });
    }

    const command = expandHome(applyCommandTemplate(commandConfig.command, filePath));
    const args = buildArgs(commandConfig.args, filePath);
    const cwd = resolveWorkingDirectory(filePath);
    const env = await getCommandEnv();
    if (!shouldContinue()) {
        return { code: null, stdout: '', stderr: '', error: 'cancelled' };
    }
    output.appendLine(`[${label}] ${formatCommand(command, args)}`);

    return new Promise((resolve) => {
        let proc: cp.ChildProcess;
        try {
            proc = cp.spawn(command, args, {
                cwd,
                detached: process.platform !== 'win32',
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            resolve({ code: null, stdout: '', stderr: '', error: String(err) });
            return;
        }

        registerProcess(filePath, proc);

        let stdout = '';
        let stderr = '';
        let done = false;

        const timer = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            unregisterProcess(filePath, proc);
            terminateProcessTree(proc);
            output.appendLine(`[${label}] killed: timeout after ${timeoutMs}ms`);
            resolve({ code: null, stdout, stderr, error: 'timeout' });
        }, timeoutMs);

        proc.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        proc.on('error', (err: Error) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            unregisterProcess(filePath, proc);
            resolve({ code: null, stdout, stderr, error: err.message });
        });

        proc.on('close', (code: number | null) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            unregisterProcess(filePath, proc);
            resolve({ code, stdout, stderr });
        });
    });
}

function logCommandResult(
    label: string,
    result: CommandResult,
    output: vscode.OutputChannel,
    parsedCount?: number
): void {
    const parsedSuffix = parsedCount === undefined ? '' : `, parsed ${parsedCount} diagnostic(s)`;
    output.appendLine(`[${label}] done: ${formatCommandStatus(result)}${parsedSuffix}`);
}

async function runPreCommands(
    ownerName: string,
    preCommands: CommandConfig[],
    filePath: string,
    output: vscode.OutputChannel,
    shouldContinue: () => boolean = () => true
): Promise<boolean> {
    for (const preCommand of preCommands) {
        if (!shouldContinue()) {
            return false;
        }
        const preCommandName = preCommand.name ?? preCommand.command;
        const label = `${ownerName}:pre:${preCommandName}`;
        const result = await runCommand(label, preCommand, filePath, output, shouldContinue);
        logCommandResult(label, result, output);
        if (result.code !== 0) {
            output.appendLine(`[${ownerName}] skipped: pre-command '${preCommandName}' failed`);
            return false;
        }
    }

    return true;
}

export function parseLinterOutput(
    linter: LinterConfig,
    result: CommandResult
): vscode.Diagnostic[] {
    const cfg = linter.parser;
    const text =
        cfg.output === 'stdout'
            ? result.stdout
            : cfg.output === 'stderr'
              ? result.stderr
              : `${result.stdout}\n${result.stderr}`;
    const diagnostics = parseRegexOutput(text, cfg, linter.name);

    return diagnostics;
}

function findDiagnosticEndCharacter(text: string, startCharacter: number): number {
    let endCharacter = startCharacter;
    while (endCharacter < text.length && !/\s/.test(text[endCharacter])) {
        endCharacter++;
    }

    if (endCharacter > startCharacter) {
        return endCharacter;
    }

    return Math.min(text.length, startCharacter + 1);
}

export async function normalizeDiagnosticRanges(
    filePath: string,
    diagnostics: vscode.Diagnostic[]
): Promise<void> {
    if (diagnostics.length === 0) {
        return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    for (const diagnostic of diagnostics) {
        if (diagnostic.range.start.line >= document.lineCount) {
            continue;
        }

        const line = document.lineAt(diagnostic.range.start.line);
        if (line.isEmptyOrWhitespace) {
            continue;
        }

        const startCharacter = diagnosticHasExplicitColumn(diagnostic)
            ? diagnostic.range.start.character
            : line.firstNonWhitespaceCharacterIndex;
        const boundedStartCharacter = Math.min(
            Math.max(0, startCharacter),
            Math.max(0, line.text.length - 1)
        );
        const endCharacter = findDiagnosticEndCharacter(line.text, boundedStartCharacter);
        diagnostic.range = new vscode.Range(
            diagnostic.range.start.line,
            boundedStartCharacter,
            diagnostic.range.start.line,
            endCharacter
        );
    }
}

async function spawnLinter(
    linter: LinterConfig,
    filePath: string,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem,
    trigger: RunMode = 'manual',
    shouldContinue: () => boolean = () => true
): Promise<vscode.Diagnostic[]> {
    if (!shouldContinue()) {
        return [];
    }

    let fileStat: fs.Stats | undefined;
    if (shouldStatFile(linter, trigger)) {
        try {
            fileStat = await fs.promises.stat(filePath);
        } catch (err) {
            output.appendLine(`[${linter.name}] stat failed: ${String(err)}`);
            // If stat fails, proceed to run the linter normally.
        }
    }

    if (
        fileStat !== undefined &&
        !shouldProcessLinterFile(fileStat.size, linter.maxFileSize)
    ) {
        output.appendLine(
            `[${linter.name}] skipped: file size ${fileStat.size} bytes exceeds maxFileSize ${linter.maxFileSize} bytes`
        );
        return [];
    }

    if (trigger !== 'manual') {
        const key = linterCacheKey(filePath, linter.name);
        const cached = linterDiagnosticsCache.get(key);
        if (cached !== undefined && fileStat !== undefined) {
            if (fileStat.mtimeMs === cached.mtime && fileStat.size === cached.size) {
                return cached.diagnostics;
            }
        }
    }

    startLinterStatus(linter.name, statusBar);
    try {
        const shouldRunLinter = await runPreCommands(
            linter.name,
            linter.preCommands ?? [],
            filePath,
            output,
            shouldContinue
        );
        if (!shouldRunLinter || !shouldContinue()) {
            return [];
        }

        const result = await runCommand(linter.name, linter, filePath, output, shouldContinue, linter.timeout ?? TIMEOUT_MS);
        if (!shouldContinue()) {
            return [];
        }
        const diags = parseLinterOutput(linter, result);
        await normalizeDiagnosticRanges(filePath, diags);
        logCommandResult(linter.name, result, output, diags.length);

        try {
            const stat = fileStat ?? await fs.promises.stat(filePath);
            linterDiagnosticsCache.set(linterCacheKey(filePath, linter.name), {
                mtime: stat.mtimeMs,
                size: stat.size,
                diagnostics: diags,
            });
        } catch {
            // Cache update failure is non-critical
        }

        return diags;
    } catch (err) {
        output.appendLine(`[${linter.name}] failed: ${String(err)}`);
        return [];
    } finally {
        stopLinterStatus(linter.name, statusBar);
    }
}

async function spawnTargetLinters(
    target: ResolvedTargetConfig,
    filePath: string,
    trigger: RunMode,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem,
    onLinterDiagnostics: DiagnosticsHandler,
    shouldContinue: () => boolean = () => true
): Promise<vscode.Diagnostic[]> {
    if (!shouldContinue()) {
        return [];
    }

    const matchingLinters = target.linters.filter((linter) => shouldRunLinter(linter, trigger));
    if (matchingLinters.length === 0) {
        return [];
    }

    const shouldRunLinters = await runPreCommands(
        target.name,
        target.preCommands,
        filePath,
        output,
        shouldContinue
    );
    if (!shouldRunLinters || !shouldContinue()) {
        return [];
    }

    const diagnostics = await Promise.all(
        matchingLinters.map(async (linter) => {
            const linterDiagnostics = await spawnLinter(
                linter,
                filePath,
                output,
                statusBar,
                trigger,
                shouldContinue
            );
            onLinterDiagnostics(linter.name, linterDiagnostics);
            return linterDiagnostics;
        })
    );

    return diagnostics.flat();
}

function shouldRunFixer(fixer: FixerConfig, trigger: FixerRunMode): boolean {
    return fixer.enabled !== false && (trigger === 'manual' || fixer.run === trigger);
}

function getFixerName(fixer: FixerConfig): string {
    return fixer.name ?? fixer.command;
}

function targetFixerToRunnable(target: ResolvedTargetConfig, fixer: FixerConfig): RunnableFixer {
    return {
        label: getFixerName(fixer),
        description: target.name,
        detail: formatCommand(fixer.command, fixer.args),
        targetName: target.name,
        fixer,
    };
}

function linterToRunnable(target: ResolvedTargetConfig, linter: LinterConfig): RunnableLinter {
    return {
        label: linter.name,
        description: target.name,
        detail: formatCommand(linter.command, linter.args),
        target,
        linter,
    };
}

async function runTargetFixer(
    targetName: string,
    fixer: FixerConfig,
    filePath: string,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): Promise<void> {
    const fixerName = fixer.name ?? fixer.command;
    const label = `${targetName}:fix:${fixerName}`;
    const statusName = `${targetName}:fix`;
    startLinterStatus(statusName, statusBar);
    try {
        const result = await runCommand(label, fixer, filePath, output);
        logCommandResult(label, result, output);
    } catch (err) {
        output.appendLine(`[${label}] failed: ${String(err)}`);
    } finally {
        stopLinterStatus(statusName, statusBar);
    }
}

export function collectRunnableFixers(
    targets: ResolvedTargetConfig[],
    filePath: string,
    trigger: FixerRunMode = 'manual'
): RunnableFixer[] {
    const matching = targets.filter((target) => matchesTarget(filePath, target));
    const fixers: RunnableFixer[] = [];

    for (const target of matching) {
        for (const fixer of target.fixers) {
            if (shouldRunFixer(fixer, trigger)) {
                fixers.push(targetFixerToRunnable(target, fixer));
            }
        }
    }

    return fixers;
}

export function getRunnableFixers(
    filePath: string,
    trigger: FixerRunMode = 'manual'
): RunnableFixer[] {
    return collectRunnableFixers(getConfiguredTargets(filePath), filePath, trigger);
}

export function collectRunnableLinters(
    targets: ResolvedTargetConfig[],
    filePath: string,
    trigger: RunMode = 'manual'
): RunnableLinter[] {
    const matching = targets.filter((target) => matchesTarget(filePath, target));
    const linters: RunnableLinter[] = [];

    for (const target of matching) {
        for (const linter of target.linters) {
            if (shouldRunLinter(linter, trigger)) {
                linters.push(linterToRunnable(target, linter));
            }
        }
    }

    return linters;
}

export function getRunnableLinters(filePath: string, trigger: RunMode = 'manual'): RunnableLinter[] {
    return collectRunnableLinters(getConfiguredTargets(filePath), filePath, trigger);
}

export function matchesIgnorePatterns(filePath: string, patterns: string[]): boolean {
    if (patterns.length === 0) {
        return false;
    }
    return matchesPatterns(filePath, patterns);
}

async function checkGitIgnore(filePath: string): Promise<boolean> {
    const cwd = resolveWorkingDirectory(filePath);
    if (cwd === undefined) {
        return false;
    }
    return new Promise<boolean>((resolve) => {
        let done = false;
        // filePath is a VS Code file URI path (already validated by the editor).
        // It is passed as an argv element, not interpolated into a shell string,
        // so there is no shell-injection risk. The -- separator prevents git from
        // misinterpreting paths that start with '-'.
        const proc = cp.spawn('git', ['check-ignore', '-q', '--', filePath], {
            cwd,
            stdio: 'ignore',
        });
        proc.on('close', (code) => {
            if (done) {
                return;
            }
            done = true;
            resolve(code === 0);
        });
        proc.on('error', () => {
            if (done) {
                return;
            }
            done = true;
            resolve(false);
        });
    });
}

async function shouldSkipFile(filePath: string): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('lintRunner');
    const ignorePatterns = config.get<string[]>('ignorePatterns') ?? [];
    if (matchesIgnorePatterns(filePath, ignorePatterns)) {
        return true;
    }
    if (config.get<boolean>('respectGitignore') === true) {
        return checkGitIgnore(filePath);
    }
    return false;
}

function createDiagnosticsRun(
    filePath: string,
    uri: vscode.Uri,
    diagnostics: vscode.DiagnosticCollection,
    runId: number,
    linterNames: string[]
): {
    publish: DiagnosticsHandler;
    finish: () => void;
    abort: () => void;
} {
    // Only clear results for the linters that are about to re-run so that
    // diagnostics produced by other linters (e.g. phpcs from a previous save)
    // remain visible while this run (e.g. a manual phpstan) executes.
    const uriString = uri.toString();
    const linterMap = getOrCreateLinterMap(uriString);
    for (const name of linterNames) {
        linterMap.delete(name);
    }
    republishMergedDiagnostics(uri, linterMap, diagnostics);

    const isActive = (): boolean => isActiveFileRun(filePath, runId);

    return {
        publish(linterName, diags) {
            if (!isActive()) {
                return;
            }
            linterMap.set(linterName, diags);
            republishMergedDiagnostics(uri, linterMap, diagnostics);
        },
        finish() {
            finishFileRun(filePath, runId);
        },
        abort() {
            finishFileRun(filePath, runId);
        },
    };
}

async function runRunnableFixer(
    fixer: RunnableFixer,
    filePath: string,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): Promise<void> {
    await runTargetFixer(fixer.targetName, fixer.fixer, filePath, output, statusBar);
}

export async function runLinters(
    filePath: string,
    trigger: RunMode,
    diagnostics: vscode.DiagnosticCollection,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): Promise<void> {
    const runId = startFileRun(filePath);
    const shouldContinue = (): boolean => isActiveFileRun(filePath, runId);

    if (await shouldSkipFile(filePath)) {
        finishFileRun(filePath, runId);
        return;
    }

    if (!shouldContinue()) {
        return;
    }

    const targets = getConfiguredTargets(filePath);
    const uri = vscode.Uri.file(filePath);

    const matching = targets.filter((target) => matchesTarget(filePath, target));
    if (matching.length === 0) {
        finishFileRun(filePath, runId);
        return;
    }

    const linterNames = [...new Set(matching.flatMap((target) =>
        target.linters
            .filter((linter) => shouldRunLinter(linter, trigger))
            .map((linter) => linter.name)
    ))];
    const { publish, finish, abort } = createDiagnosticsRun(filePath, uri, diagnostics, runId, linterNames);

    if (!shouldContinue()) {
        abort();
        return;
    }

    return Promise.all(
        matching.map((target) =>
            spawnTargetLinters(
                target,
                filePath,
                trigger,
                output,
                statusBar,
                publish,
                shouldContinue
            )
        )
    )
        .then(() => {
            finish();
        })
        .then(undefined, (err: unknown) => {
            abort();
            output.appendLine(`[LintRunner] failed: ${String(err)}`);
        });
}

export async function runFixers(
    filePath: string,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem,
    trigger: FixerRunMode = 'manual',
    fixers: readonly RunnableFixer[] = getRunnableFixers(filePath, trigger)
): Promise<number> {
    if (await shouldSkipFile(filePath)) {
        return 0;
    }

    let fixersRun = 0;

    for (const fixer of fixers) {
        fixersRun++;
        await runRunnableFixer(fixer, filePath, output, statusBar);
    }

    return fixersRun;
}

export async function runRunnableLinters(
    filePath: string,
    diagnostics: vscode.DiagnosticCollection,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem,
    linters: readonly RunnableLinter[]
): Promise<number> {
    if (linters.length === 0) {
        return 0;
    }

    const runId = startFileRun(filePath);
    const shouldContinue = (): boolean => isActiveFileRun(filePath, runId);
    const uri = vscode.Uri.file(filePath);
    const linterNames = [...new Set(linters.map((r) => r.linter.name))];
    const { publish, finish, abort } = createDiagnosticsRun(filePath, uri, diagnostics, runId, linterNames);
    let lintersRun = 0;
    const lintersByTarget = new Map<ResolvedTargetConfig, RunnableLinter[]>();

    for (const runnable of linters) {
        const existing = lintersByTarget.get(runnable.target);
        if (existing === undefined) {
            lintersByTarget.set(runnable.target, [runnable]);
        } else {
            existing.push(runnable);
        }
    }

    try {
        await Promise.all(
            [...lintersByTarget.entries()].map(async ([target, targetLinters]) => {
                const shouldRunTargetLinters = await runPreCommands(
                    target.name,
                    target.preCommands,
                    filePath,
                    output,
                    shouldContinue
                );
                if (!shouldRunTargetLinters || !shouldContinue()) {
                    return;
                }

                await Promise.all(
                    targetLinters.map(async (runnable) => {
                        lintersRun++;
                        const linterDiagnostics = await spawnLinter(
                            runnable.linter,
                            filePath,
                            output,
                            statusBar,
                            'manual',
                            shouldContinue
                        );
                        publish(runnable.linter.name, linterDiagnostics);
                    })
                );
            })
        );
        finish();
    } catch (err) {
        abort();
        output.appendLine(`[LintRunner] failed: ${String(err)}`);
    }

    return lintersRun;
}
