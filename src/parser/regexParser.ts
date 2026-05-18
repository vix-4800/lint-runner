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

/**
 * Parses a regex capture as an exact base-10 integer.
 *
 * @param value Raw named capture value from the regex match.
 * @returns The parsed integer, or undefined when the capture is missing or contains
 * non-integer content such as partial numeric text.
 */
function parseIntegerGroup(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d+$/.test(value)) {
        return undefined;
    }

    return Number.parseInt(value, 10);
}

function hasInvalidNumericCapture(rawValue: string | undefined, parsedValue: number | undefined): boolean {
    return rawValue !== undefined && parsedValue === undefined;
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
            const rawCol = groups['col'];
            const rawEndLine = groups['endLine'];
            const rawEndCol = groups['endCol'];
            const lineNumber = parseIntegerGroup(rawLine);
            const colNumber = parseIntegerGroup(rawCol);
            const endLineNumber = parseIntegerGroup(rawEndLine);
            const endColNumber = parseIntegerGroup(rawEndCol);

            if (
                lineNumber === undefined ||
                hasInvalidNumericCapture(rawCol, colNumber) ||
                hasInvalidNumericCapture(rawEndLine, endLineNumber) ||
                hasInvalidNumericCapture(rawEndCol, endColNumber)
            ) {
                if (isZeroWidthMatch) {
                    if (regex.lastIndex >= output.length) {
                        break;
                    }
                    regex.lastIndex++;
                }
                continue;
            }

            const line = Math.max(0, lineNumber - 1);
            const col = colNumber !== undefined ? Math.max(0, colNumber - 1) : undefined;
            const severity = parseSeverity(groups['severity'], config.defaultSeverity);
            const message = formatMessage(rawMessage, config.messageFormat);
            const code = groups['code'];

            const diagnostic = createDiagnostic(line, col, message, severity);
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
