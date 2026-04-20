import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseAnsibleLintOutput } from './parser/ansibleLintParser.js';
import { parseJsonOutput } from './parser/jsonParser.js';
import { parseJsonlintOutput } from './parser/jsonlintParser.js';
import { parseLinthtmlOutput } from './parser/linthtmlParser.js';
import { parseParsableOutput } from './parser/parsableParser.js';
import { parseXmllintOutput } from './parser/xmllintParser.js';

const runningLinters = new Map<string, number>();
const activeRunIds = new Map<string, number>();
let nextRunId = 0;

const SUPPORTED_PARSERS = [
    'json',
    'jsonlint',
    'parsable',
    'xmllint',
    'linthtml',
    'ansible-lint',
] as const;

type ParserName = (typeof SUPPORTED_PARSERS)[number];

export interface CommandConfig {
    name?: string;
    command: string;
    args: string[];
}

export interface LinterConfig {
    name: string;
    filePatterns: string[];
    command: string;
    args: string[];
    parser: ParserName | string;
    run: 'manual' | 'onSave';
    preCommands?: CommandConfig[];
    fixCommand?: CommandConfig;
    showDiagnosticCodes?: boolean;
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

function expandHome(value: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return value.replace(/(^|=)~(?=\/|$)/, `$1${home}`);
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

function runCommand(
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
    output.appendLine(`[${label}] ${formatCommand(command, args)}`);

    return new Promise((resolve) => {
        let proc: cp.ChildProcess;
        try {
            proc = cp.spawn(command, args, { cwd });
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
    linter: LinterConfig,
    filePath: string,
    output: vscode.OutputChannel
): Promise<boolean> {
    for (const preCommand of linter.preCommands ?? []) {
        const preCommandName = preCommand.name ?? preCommand.command;
        const label = `${linter.name}:pre:${preCommandName}`;
        const result = await runCommand(label, preCommand, filePath, output);
        logCommandResult(label, result, output);
        if (result.code !== 0) {
            output.appendLine(`[${linter.name}] skipped: pre-command '${preCommandName}' failed`);
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
    statusBar: vscode.StatusBarItem,
    onDone: (diags: vscode.Diagnostic[]) => void
): Promise<void> {
    startLinterStatus(linter.name, statusBar);
    try {
        const shouldRunLinter = await runPreCommands(linter, filePath, output);
        if (!shouldRunLinter) {
            onDone([]);
            return;
        }

        const result = await runCommand(linter.name, linter, filePath, output);
        const diags = parseLinterOutput(linter, result);
        await moveLineStartDiagnosticsToFirstNonWhitespace(filePath, diags);
        logCommandResult(linter.name, result, output, diags.length);
        onDone(diags);
    } catch (err) {
        output.appendLine(`[${linter.name}] failed: ${String(err)}`);
        onDone([]);
    } finally {
        stopLinterStatus(linter.name, statusBar);
    }
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

export function runLinters(
    filePath: string,
    trigger: 'manual' | 'onSave',
    diagnostics: vscode.DiagnosticCollection,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): void {
    const config = vscode.workspace.getConfiguration('lintRunner');
    const linters = config.get<LinterConfig[]>('linters') ?? [];
    const uri = vscode.Uri.file(filePath);
    const runId = nextRunId++;
    activeRunIds.set(filePath, runId);
    diagnostics.delete(uri);

    const matching = linters.filter(
        (l) =>
            matchesPatterns(filePath, l.filePatterns) &&
            (trigger === 'manual' || l.run === 'onSave')
    );

    if (matching.length === 0) {
        activeRunIds.delete(filePath);
        return;
    }

    const allDiags: vscode.Diagnostic[] = [];
    let remaining = matching.length;

    const onLinterDone = (diags: vscode.Diagnostic[]): void => {
        allDiags.push(...diags);
        remaining--;
        if (remaining === 0) {
            if (activeRunIds.get(filePath) !== runId) {
                return;
            }
            activeRunIds.delete(filePath);
            diagnostics.set(uri, allDiags);
        }
    };

    for (const linter of matching) {
        spawnLinter(linter, filePath, output, statusBar, onLinterDone);
    }
}

export async function runFixers(
    filePath: string,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): Promise<number> {
    const config = vscode.workspace.getConfiguration('lintRunner');
    const linters = config.get<LinterConfig[]>('linters') ?? [];
    const matching = linters.filter(
        (l) => matchesPatterns(filePath, l.filePatterns) && l.fixCommand !== undefined
    );

    for (const linter of matching) {
        await runFixer(linter, filePath, output, statusBar);
    }

    return matching.length;
}
