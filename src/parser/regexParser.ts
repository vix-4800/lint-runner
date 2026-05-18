import * as vscode from 'vscode';
import { createDiagnostic } from './diagnostic.js';

export interface RegexParserConfig {
    pattern: string;
    flags?: string;
    output?: 'stdout' | 'stderr' | 'both';
    defaultSeverity?: 'error' | 'warning' | 'info' | 'information';
    messageFormat?: 'plain' | 'json';
}

const invalidRegexWarned = new Set<string>();

function ensureGlobalFlag(flags: string): string {
    return flags.includes('g') ? flags : `${flags}g`;
}

function parseSeverity(
    value: string | undefined,
    defaultSeverity: string | undefined
): vscode.DiagnosticSeverity {
    const level = value?.toLowerCase() ?? defaultSeverity?.toLowerCase();
    switch (level) {
        case 'error':
        case 'err':
        case 'fatal':
            return vscode.DiagnosticSeverity.Error;
        case 'notice':
        case 'warn':
        case 'warning':
            return vscode.DiagnosticSeverity.Warning;
        case 'info':
        case 'information':
        case 'hint':
        case 'note':
        case 'style':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Warning;
    }
}

function formatMessage(message: string, messageFormat: string | undefined): string {
    if (messageFormat !== 'json') {
        return message;
    }

    try {
        return JSON.parse(`"${message}"`) as string;
    } catch {
        return message;
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
        const isZeroWidthMatch = match[0] === '';
        const groups = match.groups ?? {};

        const rawLine = groups['line'];
        const rawMessage = groups['message'];

        if (rawLine !== undefined && rawMessage !== undefined) {
            const line = Math.max(0, parseInt(rawLine, 10) - 1);
            const rawCol = groups['col'];
            const col = rawCol !== undefined ? Math.max(0, parseInt(rawCol, 10) - 1) : undefined;
            const rawEndLine = groups['endLine'];
            const endLine =
                rawEndLine !== undefined ? Math.max(0, parseInt(rawEndLine, 10) - 1) : undefined;
            const rawEndCol = groups['endCol'];
            const endCol =
                rawEndCol !== undefined ? Math.max(0, parseInt(rawEndCol, 10) - 1) : undefined;
            const severity = parseSeverity(groups['severity'], config.defaultSeverity);
            const message = formatMessage(rawMessage, config.messageFormat);
            const code = groups['code'];

            const diagnostic = createDiagnostic(line, col, message, severity, endLine, endCol);
            diagnostic.source = source;
            if (code !== undefined) {
                diagnostic.code = code;
            }
            diagnostics.push(diagnostic);
        }

        if (isZeroWidthMatch) {
            if (regex.lastIndex >= output.length) {
                break;
            }
            regex.lastIndex++;
            continue;
        }
    }

    return diagnostics;
}
