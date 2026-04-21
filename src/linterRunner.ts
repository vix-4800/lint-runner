import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseAnsibleLintOutput } from './parser/ansibleLintParser.js';
import { parseJsonOutput } from './parser/jsonParser.js';
import { parseJsonlintOutput } from './parser/jsonlintParser.js';
import { parseLinthtmlOutput } from './parser/linthtmlParser.js';
import { parseParsableOutput } from './parser/parsableParser.js';
import { parseTaploOutput } from './parser/taploParser.js';
import { parseXmllintOutput } from './parser/xmllintParser.js';

const runningLinters = new Map<string, number>();
const activeRunIds = new Map<string, number>();
let nextRunId = 0;

const SUPPORTED_PARSERS = [
    'json',
    'jsonlint',
    'parsable',
    'taplo',
    'xmllint',
    'linthtml',
    'ansible-lint',
] as const;
const SHELL_ENV_TIMEOUT_MS = 3000;
const SHELL_PATH_PREFIX = 'LINT_RUNNER_PATH=';

type ParserName = (typeof SUPPORTED_PARSERS)[number];
type RunMode = 'manual' | 'onSave' | 'onOpen';
type FixerRunMode = Extract<RunMode, 'manual' | 'onSave'>;
type DiagnosticsHandler = (diagnostics: vscode.Diagnostic[]) => void;
let commandEnvPromise: Promise<NodeJS.ProcessEnv> | undefined;

export interface CommandConfig {
    name?: string;
    command: string;
    args: string[];
}

export interface FixerConfig extends CommandConfig {
    run?: FixerRunMode;
    enabled?: boolean;
}

export interface TargetLinterConfig {
    name: string;
    command: string;
    args: string[];
    parser: ParserName | string;
    run?: RunMode;
    enabled?: boolean;
    preCommands?: CommandConfig[];
    fixCommand?: FixerConfig;
    showDiagnosticCodes?: boolean;
}

export interface LinterConfig extends TargetLinterConfig {
    filePatterns: string[];
    run: RunMode;
}

export interface TargetConfig {
    name: string;
    filePatterns: string[];
    run?: RunMode;
    preCommands?: CommandConfig[];
    linters?: TargetLinterConfig[];
    fixers?: FixerConfig[];
    showDiagnosticCodes?: boolean;
}

export interface ResolvedTargetConfig {
    name: string;
    filePatterns: string[];
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
    linter?: LinterConfig;
}

export interface CommandResult {
    code: number | null;
    stdout: string;
    stderr: string;
    error?: string;
}

function globToRegex(pattern: string): RegExp {
    let result = '^';
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
        } else if (/[.+^${}()|[\]\\]/.test(c)) {
            result += `\\${c}`;
        } else {
            result += c;
        }
    }
    result += '$';
    return new RegExp(result);
}

function normalizePath(value: string): string {
    return value.split(path.sep).join('/');
}

function matchesPatterns(filePath: string, patterns: string[]): boolean {
    const fileName = path.basename(filePath);
    const relativePath = normalizePath(vscode.workspace.asRelativePath(filePath, false));
    const normalizedFilePath = normalizePath(filePath);

    return patterns.some((pattern) => {
        const re = globToRegex(pattern);
        return re.test(fileName) || re.test(relativePath) || re.test(normalizedFilePath);
    });
}

function normalizeTargetConfig(target: TargetConfig): ResolvedTargetConfig {
    const targetRun = target.run ?? 'onSave';
    const targetShowDiagnosticCodes = target.showDiagnosticCodes;
    const linters = (target.linters ?? []).map((linter) => ({
        ...linter,
        filePatterns: target.filePatterns,
        run: linter.run ?? targetRun,
        showDiagnosticCodes: linter.showDiagnosticCodes ?? targetShowDiagnosticCodes,
    }));

    return {
        name: target.name,
        filePatterns: target.filePatterns,
        preCommands: target.preCommands ?? [],
        linters,
        fixers: target.fixers ?? [],
    };
}

function legacyLinterToTarget(linter: LinterConfig): ResolvedTargetConfig {
    return {
        name: linter.name,
        filePatterns: linter.filePatterns,
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

function getConfiguredTargets(): ResolvedTargetConfig[] {
    const config = vscode.workspace.getConfiguration('lintRunner');
    const targets = config.get<TargetConfig[]>('targets') ?? [];
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

export function shouldRunLinter(linter: LinterConfig, trigger: RunMode): boolean {
    return (
        linter.enabled !== false &&
        (trigger === 'manual' ||
            linter.run === trigger ||
            (trigger === 'onSave' && linter.run === 'onOpen'))
    );
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
    output: vscode.OutputChannel
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
    output.appendLine(`[${label}] ${formatCommand(command, args)}`);

    return new Promise((resolve) => {
        let proc: cp.ChildProcess;
        try {
            proc = cp.spawn(command, args, { cwd, env });
        } catch (err) {
            resolve({ code: null, stdout: '', stderr: '', error: String(err) });
            return;
        }

        let stdout = '';
        let stderr = '';
        let done = false;

        const timer = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            proc.kill();
            output.appendLine(`[${label}] killed: timeout after ${TIMEOUT_MS}ms`);
            resolve({ code: null, stdout, stderr, error: 'timeout' });
        }, TIMEOUT_MS);

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
            resolve({ code: null, stdout, stderr, error: err.message });
        });

        proc.on('close', (code: number | null) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
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
    output: vscode.OutputChannel
): Promise<boolean> {
    for (const preCommand of preCommands) {
        const preCommandName = preCommand.name ?? preCommand.command;
        const label = `${ownerName}:pre:${preCommandName}`;
        const result = await runCommand(label, preCommand, filePath, output);
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
    let diagnostics: vscode.Diagnostic[];

    switch (linter.parser) {
        case 'json':
            diagnostics = parseJsonOutput(result.stdout, linter.name);
            if (diagnostics.length === 0) {
                diagnostics = parseJsonOutput(result.stderr, linter.name);
            }
            break;
        case 'jsonlint':
            diagnostics = parseJsonlintOutput(result.stdout, result.stderr, linter.name);
            break;
        case 'ansible-lint':
            diagnostics = parseAnsibleLintOutput(result.stdout, linter.name);
            break;
        case 'parsable':
            diagnostics = parseParsableOutput(result.stdout, linter.name);
            break;
        case 'taplo':
            diagnostics = parseTaploOutput(`${result.stdout}\n${result.stderr}`, linter.name);
            break;
        case 'xmllint':
            diagnostics = parseXmllintOutput(result.stderr, linter.name);
            break;
        case 'linthtml':
            diagnostics = parseLinthtmlOutput(result.stdout, linter.name);
            break;
        default:
            vscode.window.showWarningMessage(
                `LintRunner: unknown parser '${linter.parser}' in linter '${linter.name}'.`
            );
            return [];
    }

    if (linter.showDiagnosticCodes === false) {
        for (const diagnostic of diagnostics) {
            diagnostic.code = undefined;
        }
    }

    return diagnostics;
}

async function moveLineStartDiagnosticsToFirstNonWhitespace(
    filePath: string,
    diagnostics: vscode.Diagnostic[]
): Promise<void> {
    if (diagnostics.length === 0) {
        return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    for (const diagnostic of diagnostics) {
        if (
            diagnostic.range.start.character !== 0 ||
            diagnostic.range.start.line >= document.lineCount
        ) {
            continue;
        }

        const line = document.lineAt(diagnostic.range.start.line);
        const firstNonWhitespace = line.firstNonWhitespaceCharacterIndex;
        if (firstNonWhitespace === 0 || line.isEmptyOrWhitespace) {
            continue;
        }

        diagnostic.range = new vscode.Range(
            diagnostic.range.start.line,
            firstNonWhitespace,
            diagnostic.range.end.line,
            Math.max(firstNonWhitespace + 1, diagnostic.range.end.character)
        );
    }
}

async function spawnLinter(
    linter: LinterConfig,
    filePath: string,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): Promise<vscode.Diagnostic[]> {
    startLinterStatus(linter.name, statusBar);
    try {
        const shouldRunLinter = await runPreCommands(
            linter.name,
            linter.preCommands ?? [],
            filePath,
            output
        );
        if (!shouldRunLinter) {
            return [];
        }

        const result = await runCommand(linter.name, linter, filePath, output);
        const diags = parseLinterOutput(linter, result);
        await moveLineStartDiagnosticsToFirstNonWhitespace(filePath, diags);
        logCommandResult(linter.name, result, output, diags.length);
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
    onLinterDiagnostics: DiagnosticsHandler
): Promise<vscode.Diagnostic[]> {
    const matchingLinters = target.linters.filter((linter) => shouldRunLinter(linter, trigger));
    if (matchingLinters.length === 0) {
        return [];
    }

    const shouldRunLinters = await runPreCommands(
        target.name,
        target.preCommands,
        filePath,
        output
    );
    if (!shouldRunLinters) {
        return [];
    }

    const diagnostics = await Promise.all(
        matchingLinters.map(async (linter) => {
            const linterDiagnostics = await spawnLinter(linter, filePath, output, statusBar);
            onLinterDiagnostics(linterDiagnostics);
            return linterDiagnostics;
        })
    );

    return diagnostics.flat();
}

async function runFixer(
    linter: LinterConfig,
    filePath: string,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): Promise<void> {
    const fixCommand = linter.fixCommand;
    if (fixCommand === undefined) {
        return;
    }

    const fixCommandName = fixCommand.name ?? fixCommand.command;
    const label = `${linter.name}:fix:${fixCommandName}`;
    const statusName = `${linter.name}:fix`;
    startLinterStatus(statusName, statusBar);
    try {
        const result = await runCommand(label, fixCommand, filePath, output);
        logCommandResult(label, result, output);
    } catch (err) {
        output.appendLine(`[${label}] failed: ${String(err)}`);
    } finally {
        stopLinterStatus(statusName, statusBar);
    }
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

function linterFixerToRunnable(target: ResolvedTargetConfig, linter: LinterConfig): RunnableFixer {
    const fixCommand = linter.fixCommand;
    if (fixCommand === undefined) {
        throw new Error(`Linter '${linter.name}' has no fix command.`);
    }

    return {
        label: getFixerName(fixCommand),
        description: `${target.name} / ${linter.name}`,
        detail: formatCommand(fixCommand.command, fixCommand.args),
        targetName: target.name,
        fixer: fixCommand,
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
    const matching = targets.filter((target) => matchesPatterns(filePath, target.filePatterns));
    const fixers: RunnableFixer[] = [];

    for (const target of matching) {
        for (const fixer of target.fixers) {
            if (shouldRunFixer(fixer, trigger)) {
                fixers.push(targetFixerToRunnable(target, fixer));
            }
        }

        for (const linter of target.linters) {
            if (linter.fixCommand !== undefined && shouldRunFixer(linter.fixCommand, trigger)) {
                fixers.push(linterFixerToRunnable(target, linter));
            }
        }
    }

    return fixers;
}

export function getRunnableFixers(
    filePath: string,
    trigger: FixerRunMode = 'manual'
): RunnableFixer[] {
    return collectRunnableFixers(getConfiguredTargets(), filePath, trigger);
}

async function runRunnableFixer(
    fixer: RunnableFixer,
    filePath: string,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): Promise<void> {
    if (fixer.linter !== undefined) {
        await runFixer(fixer.linter, filePath, output, statusBar);
        return;
    }

    await runTargetFixer(fixer.targetName, fixer.fixer, filePath, output, statusBar);
}

export function runLinters(
    filePath: string,
    trigger: RunMode,
    diagnostics: vscode.DiagnosticCollection,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): void {
    const targets = getConfiguredTargets();
    const uri = vscode.Uri.file(filePath);
    const runId = nextRunId++;
    activeRunIds.set(filePath, runId);
    diagnostics.delete(uri);
    const currentDiagnostics: vscode.Diagnostic[] = [];

    const matching = targets.filter((target) => matchesPatterns(filePath, target.filePatterns));

    if (matching.length === 0) {
        activeRunIds.delete(filePath);
        return;
    }

    Promise.all(
        matching.map((target) =>
            spawnTargetLinters(target, filePath, trigger, output, statusBar, (linterDiagnostics) => {
                if (activeRunIds.get(filePath) !== runId || linterDiagnostics.length === 0) {
                    return;
                }

                currentDiagnostics.push(...linterDiagnostics);
                diagnostics.set(uri, currentDiagnostics);
            })
        )
    )
        .then((allDiags) => {
            if (activeRunIds.get(filePath) !== runId) {
                return;
            }
            activeRunIds.delete(filePath);
            diagnostics.set(uri, allDiags.flat());
        })
        .then(undefined, (err: unknown) => {
            if (activeRunIds.get(filePath) === runId) {
                activeRunIds.delete(filePath);
            }
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
    let fixersRun = 0;

    for (const fixer of fixers) {
        fixersRun++;
        await runRunnableFixer(fixer, filePath, output, statusBar);
    }

    return fixersRun;
}
