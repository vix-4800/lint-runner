import * as vscode from 'vscode';
import { createDiagnostic } from './diagnostic.js';

// ansible-lint text output format (default / --format full):
//
//   rule-id: Short description.
//   path/to/file.yml:LINE[:COL] Detail message.
//   <blank line>
//   ...

const RULE_LINE_RE = /^([\w[\].-]+):\s+(.+)$/;
const LOCATION_LINE_RE = /^.+?:(\d+)(?::(\d+))?(?:\s+(.*))?$/;

interface JsonIssue {
    check_name?: unknown;
    description?: unknown;
    content?: { body?: unknown };
    location?: {
        positions?: { begin?: { line?: unknown; column?: unknown } };
        lines?: { begin?: unknown };
    };
}

function extractJsonPayload(output: string): unknown {
    const trimmed = output.trim();
    if (trimmed === '') {
        return undefined;
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        // Some ansible-lint versions print warnings before the JSON payload.
    }

    for (let start = 0; start < trimmed.length; start++) {
        const open = trimmed[start];
        if (open !== '{' && open !== '[') {
            continue;
        }

        const close = open === '{' ? '}' : ']';
        for (
            let end = trimmed.lastIndexOf(close);
            end > start;
            end = trimmed.lastIndexOf(close, end - 1)
        ) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1));
            } catch {
                // Try earlier closing bracket.
            }
        }
    }

    return undefined;
}

function parseJsonIssues(stdout: string, source: string): vscode.Diagnostic[] {
    const raw = extractJsonPayload(stdout);
    if (!Array.isArray(raw)) {
        return [];
    }

    const diagnostics: vscode.Diagnostic[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }

        const issue = entry as JsonIssue;
        const lineValue =
            issue.location?.positions?.begin?.line ?? issue.location?.lines?.begin;
        if (typeof lineValue !== 'number' || typeof issue.check_name !== 'string') {
            continue;
        }

        const columnValue = issue.location?.positions?.begin?.column;
        const body = typeof issue.content?.body === 'string' ? issue.content.body.trim() : '';
        const description =
            typeof issue.description === 'string' ? issue.description.trim() : issue.check_name;
        const message = body === '' ? `${issue.check_name}: ${description}` : `${issue.check_name}: ${body}`;
        const diagnostic = createDiagnostic(
            Math.max(0, lineValue - 1),
            typeof columnValue === 'number' ? Math.max(0, columnValue - 1) : undefined,
            message,
            vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = source;
        diagnostic.code = issue.check_name;
        diagnostics.push(diagnostic);
    }

    return diagnostics;
}

export function parseAnsibleLintOutput(stdout: string, source: string): vscode.Diagnostic[] {
    const jsonDiagnostics = parseJsonIssues(stdout, source);
    if (jsonDiagnostics.length > 0) {
        return jsonDiagnostics;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    const lines = stdout.split('\n');

    let i = 0;
    while (i < lines.length) {
        const ruleLine = lines[i].trim();

        if (!ruleLine) {
            i++;
            continue;
        }

        const ruleMatch = RULE_LINE_RE.exec(ruleLine);
        if (ruleMatch !== null && i + 1 < lines.length) {
            const ruleId = ruleMatch[1];
            const ruleDesc = ruleMatch[2];
            const locationLine = lines[i + 1].trim();
            const locMatch = LOCATION_LINE_RE.exec(locationLine);

            if (locMatch !== null) {
                const lineNo = Math.max(0, parseInt(locMatch[1], 10) - 1);
                const colNo =
                    locMatch[2] !== undefined
                        ? Math.max(0, parseInt(locMatch[2], 10) - 1)
                        : undefined;
                const detail = locMatch[3]?.trim();
                const message = detail ? `${ruleId}: ${detail}` : `${ruleId}: ${ruleDesc}`;

                const diag = createDiagnostic(
                    lineNo,
                    colNo,
                    message,
                    vscode.DiagnosticSeverity.Warning
                );
                diag.source = source;
                diag.code = ruleId;
                diagnostics.push(diag);

                i += 2;
                continue;
            }
        }

        i++;
    }

    return diagnostics;
}
