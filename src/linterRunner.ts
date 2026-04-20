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
    parser: string;
    run: 'manual' | 'onSave';
    preCommands?: CommandConfig[];
    showDiagnosticCodes?: boolean;
}

interface CommandResult {
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

function matchesPatterns(filePath: string, patterns: string[]): boolean {
    const fileName = path.basename(filePath);
    return patterns.some((pattern) => {
        const re = globToRegex(pattern);
        return re.test(fileName) || re.test(filePath);
    });
}

function expandHome(value: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return value.replace(/^~(?=\/|$)/, home);
}

function buildArgs(args: string[], filePath: string): string[] {
    return args.map((arg) => expandHome(arg.replace('${file}', filePath)));
}

function formatCommand(command: string, args: string[]): string {
    return [command, ...args].join(' ');
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

function runCommand(
    label: string,
    commandConfig: CommandConfig,
    filePath: string,
    output: vscode.OutputChannel
): Promise<CommandResult> {
    const command = expandHome(commandConfig.command);
    const args = buildArgs(commandConfig.args, filePath);
    output.appendLine(`[${label}] run: ${formatCommand(command, args)}`);

    return new Promise((resolve) => {
        let proc: cp.ChildProcess;
        try {
            proc = cp.spawn(command, args, { shell: true });
        } catch (err) {
            resolve({ code: null, stdout: '', stderr: '', error: String(err) });
            return;
        }

        let stdout = '';
        let stderr = '';
        let done = false;
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
            resolve({ code: null, stdout, stderr, error: err.message });
        });

        proc.on('close', (code: number | null) => {
            if (done) {
                return;
            }
            done = true;
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

function parseLinterOutput(linter: LinterConfig, result: CommandResult): vscode.Diagnostic[] {
    let diagnostics: vscode.Diagnostic[];
    if (linter.parser === 'json') {
        diagnostics = parseJsonOutput(result.stdout, linter.name);
    } else if (linter.parser === 'jsonlint') {
        diagnostics = parseJsonlintOutput(result.stdout, result.stderr, linter.name);
    } else if (linter.parser === 'ansible-lint') {
        diagnostics = parseAnsibleLintOutput(result.stdout, linter.name);
    } else if (linter.parser === 'parsable') {
        diagnostics = parseParsableOutput(result.stdout, linter.name);
    } else if (linter.parser === 'xmllint') {
        diagnostics = parseXmllintOutput(result.stderr, linter.name);
    } else if (linter.parser === 'linthtml') {
        diagnostics = parseLinthtmlOutput(result.stdout, linter.name);
    } else {
        diagnostics = [];
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
        if (diagnostic.range.start.character !== 0 || diagnostic.range.start.line >= document.lineCount) {
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

export function runLinters(
    filePath: string,
    trigger: 'manual' | 'onSave',
    diagnostics: vscode.DiagnosticCollection,
    output: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem
): void {
    const config = vscode.workspace.getConfiguration('lintRunner');
    const linters = config.get<LinterConfig[]>('linters') ?? [];

    const matching = linters.filter(
        (l) =>
            matchesPatterns(filePath, l.filePatterns) &&
            (trigger === 'manual' || l.run === 'onSave')
    );

    if (matching.length === 0) {
        return;
    }

    const uri = vscode.Uri.file(filePath);
    diagnostics.delete(uri);

    const allDiags: vscode.Diagnostic[] = [];
    let remaining = matching.length;

    const onLinterDone = (diags: vscode.Diagnostic[]): void => {
        allDiags.push(...diags);
        remaining--;
        if (remaining === 0) {
            diagnostics.set(uri, allDiags);
        }
    };

    for (const linter of matching) {
        spawnLinter(linter, filePath, output, statusBar, onLinterDone);
    }
}
