import * as vscode from 'vscode';
import { createDiagnostic } from './diagnostic.js';

export interface RegexParserConfig {
    pattern: string;
    flags?: string;
    output?: 'stdout' | 'stderr' | 'both';
}

const invalidRegexWarned = new Set<string>();

function ensureGlobalFlag(flags: string): string {
    return flags.includes('g') ? flags : `${flags}g`;
}

function parseSeverity(value: string | undefined): vscode.DiagnosticSeverity {
    switch (value?.toLowerCase()) {
        case 'error':
            return vscode.DiagnosticSeverity.Error;
        case 'info':
        case 'information':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Warning;
    }
}

export function parseRegexOutput(
    output: string,
    config: RegexParserConfig,
    source: string
): vscode.Diagnostic[] {
    const flags = ensureGlobalFlag(config.flags ?? 'g');

    let regex: RegExp;
    try {
        regex = new RegExp(config.pattern, flags);
    } catch {
        if (!invalidRegexWarned.has(config.pattern)) {
            invalidRegexWarned.add(config.pattern);
            vscode.window.showWarningMessage(
                `LintRunner: invalid regex pattern in parser config for '${source}'.`
            );
        }
        return [];
    }

    const diagnostics: vscode.Diagnostic[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(output)) !== null) {
        const groups = match.groups ?? {};

        const rawLine = groups['line'];
        const rawMessage = groups['message'];

        if (rawLine === undefined || rawMessage === undefined) {
            continue;
        }

        const line = Math.max(0, parseInt(rawLine, 10) - 1);
        const rawCol = groups['col'];
        const col = rawCol !== undefined ? Math.max(0, parseInt(rawCol, 10) - 1) : undefined;
        const severity = parseSeverity(groups['severity']);
        const code = groups['code'];

        const diagnostic = createDiagnostic(line, col, rawMessage, severity);
        diagnostic.source = source;
        if (code !== undefined) {
            diagnostic.code = code;
        }
        diagnostics.push(diagnostic);
    }

    return diagnostics;
}
