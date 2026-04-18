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

export interface LinterConfig {
    name: string;
    filePatterns: string[];
    command: string;
    args: string[];
    parser: string;
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

function expandHome(value: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return value.replace(/^~(?=\/|$)/, home);
}

function buildArgs(args: string[], filePath: string): string[] {
    return args.map((arg) => expandHome(arg.replace('${file}', filePath)));
}

function spawnLinter(
    linter: LinterConfig,
    filePath: string,
    output: vscode.OutputChannel,
    onDone: (diags: vscode.Diagnostic[]) => void
): void {
    const command = expandHome(linter.command);
    const args = buildArgs(linter.args, filePath);
    output.appendLine(`[${linter.name}] ${command} ${args.join(' ')}`);

    let proc: cp.ChildProcess;
    try {
        proc = cp.spawn(command, args, { shell: true });
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
        if (stderr.trim() !== '') {
            output.appendLine(`[${linter.name}] stderr: ${stderr.trim()}`);
        }
        output.appendLine(
            `[${linter.name}] exit code ${code ?? 'null'} | stdout bytes: ${stdout.length}`
        );
        if (stdout.length > 0) {
            output.appendLine(
                `[${linter.name}] stdout: ${stdout.slice(0, MAX_STDOUT_PREVIEW_LENGTH)}`
            );
        }
        let diags: vscode.Diagnostic[] = [];
        if (linter.parser === 'json') {
            diags = parseJsonOutput(stdout, linter.name);
        } else if (linter.parser === 'jsonlint') {
            diags = parseJsonlintOutput(stdout, stderr, linter.name);
        } else if (linter.parser === 'ansible-lint') {
            diags = parseAnsibleLintOutput(stdout, linter.name);
        } else if (linter.parser === 'parsable') {
            diags = parseParsableOutput(stdout, linter.name);
        } else if (linter.parser === 'xmllint') {
            diags = parseXmllintOutput(stderr, linter.name);
        } else if (linter.parser === 'linthtml') {
            diags = parseLinthtmlOutput(stdout, linter.name);
        } else if (stdout.length > 0 || stderr.trim().length > 0) {
            output.appendLine(
                `[${linter.name}] Parser '${linter.parser}' is not implemented; output was not parsed`
            );
        }
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

    const onLinterDone = (diags: vscode.Diagnostic[]): void => {
        allDiags.push(...diags);
        remaining--;
        if (remaining === 0) {
            diagnostics.set(uri, allDiags);
        }
    };

    for (const linter of matching) {
        spawnLinter(linter, filePath, output, onLinterDone);
    }
}
