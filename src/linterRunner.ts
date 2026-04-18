import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseJsonOutput } from './parser/jsonParser.js';

export interface LinterConfig {
    name: string;
    filePatterns: string[];
    command: string;
    args: string[];
    parser: 'json' | 'regex';
    run: 'manual' | 'onSave';
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

function buildArgs(args: string[], filePath: string): string[] {
    return args.map((arg) => arg.replace('${file}', filePath));
}

function spawnLinter(
    linter: LinterConfig,
    filePath: string,
    output: vscode.OutputChannel,
    onDone: (diags: vscode.Diagnostic[]) => void
): void {
    const args = buildArgs(linter.args, filePath);
    output.appendLine(`[${linter.name}] ${linter.command} ${args.join(' ')}`);

    let proc: cp.ChildProcess;
    try {
        proc = cp.spawn(linter.command, args, { shell: false });
    } catch (err) {
        output.appendLine(`[${linter.name}] Failed to start: ${String(err)}`);
        onDone([]);
        return;
    }

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
    });

    proc.on('error', (err: Error) => {
        output.appendLine(`[${linter.name}] Error: ${err.message}`);
        onDone([]);
    });

    proc.on('close', (code: number | null) => {
        if (stderr.trim()) {
            output.appendLine(`[${linter.name}] stderr: ${stderr.trim()}`);
        }
        output.appendLine(
            `[${linter.name}] exit code ${code ?? 'null'} | stdout bytes: ${stdout.length}`
        );
        if (stdout.length > 0) {
            output.appendLine(`[${linter.name}] stdout: ${stdout.slice(0, 500)}`);
        }
        const diags = linter.parser === 'json' ? parseJsonOutput(stdout, linter.name) : [];
        output.appendLine(`[${linter.name}] parsed ${diags.length} diagnostic(s)`);
        onDone(diags);
    });
}

export function runLinters(
    filePath: string,
    trigger: 'manual' | 'onSave',
    diagnostics: vscode.DiagnosticCollection,
    output: vscode.OutputChannel
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

    for (const linter of matching) {
        spawnLinter(linter, filePath, output, (diags) => {
            allDiags.push(...diags);
            remaining--;
            if (remaining === 0) {
                diagnostics.set(uri, allDiags);
            }
        });
    }
}
