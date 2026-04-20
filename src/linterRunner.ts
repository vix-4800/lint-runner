import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseAnsibleLintOutput } from './parser/ansibleLintParser.js';
import { parseJsonOutput } from './parser/jsonParser.js';
import { parseJsonlintOutput } from './parser/jsonlintParser.js';
import { parseLinthtmlOutput } from './parser/linthtmlParser.js';
import { parseParsableOutput } from './parser/parsableParser.js';
import { parseXmllintOutput } from './parser/xmllintParser.js';

const MAX_STDOUT_PREVIEW_LENGTH = 500;
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
    output.appendLine(`[${label}] ${command} ${args.join(' ')}`);

    return new Promise((resolve) => {
        let proc: cp.ChildProcess;
        try {
            proc = cp.spawn(command, args, { shell: true });
        } catch (err) {
            output.appendLine(`[${label}] Failed to start: ${String(err)}`);
            resolve({ code: null, stdout: '', stderr: '' });
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
            output.appendLine(`[${label}] Error: ${err.message}`);
            resolve({ code: null, stdout, stderr });
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
    output: vscode.OutputChannel
): void {
    if (result.stderr.trim() !== '') {
        output.appendLine(`[${label}] stderr: ${result.stderr.trim()}`);
    }
    output.appendLine(
        `[${label}] exit code ${result.code ?? 'null'} | stdout bytes: ${result.stdout.length}`
    );
    if (result.stdout.length > 0) {
        output.appendLine(
            `[${label}] stdout: ${result.stdout.slice(0, MAX_STDOUT_PREVIEW_LENGTH)}`
        );
    }
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
            output.appendLine(`[${linter.name}] pre-command '${preCommandName}' failed; skipping linter`);
            return false;
        }
    }

    return true;
}

function parseLinterOutput(linter: LinterConfig, result: CommandResult, output: vscode.OutputChannel): vscode.Diagnostic[] {
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
        if (result.stdout.length > 0 || result.stderr.trim().length > 0) {
            output.appendLine(
                `[${linter.name}] Parser '${linter.parser}' is not implemented; output was not parsed`
            );
        }
    }

    if (linter.showDiagnosticCodes === false) {
        for (const diagnostic of diagnostics) {
            diagnostic.code = undefined;
        }
    }

    return diagnostics;
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
        logCommandResult(linter.name, result, output);

        const diags = parseLinterOutput(linter, result, output);
        output.appendLine(`[${linter.name}] parsed ${diags.length} diagnostic(s)`);
        onDone(diags);
    } catch (err) {
        output.appendLine(`[${linter.name}] Failed: ${String(err)}`);
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
