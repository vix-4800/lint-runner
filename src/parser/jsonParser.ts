import * as vscode from 'vscode';

interface RawItem {
    line: number;
    column?: number;
    message: string;
    level?: string;
    severity?: string;
}

function isRawItem(value: unknown): value is RawItem {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const v = value as Record<string, unknown>;
    return typeof v.line === 'number' && typeof v.message === 'string';
}

function parseSeverity(level: unknown): vscode.DiagnosticSeverity {
    if (typeof level === 'number') {
        if (level >= 2) {
            return vscode.DiagnosticSeverity.Error;
        }
        if (level === 1) {
            return vscode.DiagnosticSeverity.Warning;
        }
        return vscode.DiagnosticSeverity.Information;
    }
    switch (String(level ?? '').toLowerCase()) {
        case 'error':
            return vscode.DiagnosticSeverity.Error;
        case 'info':
        case 'information':
        case 'hint':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Warning;
    }
}

function normalizeRawItems(raw: unknown[]): unknown[] {
    const items: unknown[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const obj = entry as Record<string, unknown>;

        // ESLint: [{messages: [{line, column, message, severity}]}]
        if (Array.isArray(obj.messages)) {
            items.push(...obj.messages);
            continue;
        }

        // SQLFluff: [{violations: [{start_line_no, start_line_pos, description}]}]
        if (Array.isArray(obj.violations)) {
            for (const v of obj.violations) {
                if (typeof v !== 'object' || v === null) {
                    continue;
                }
                const viol = v as Record<string, unknown>;
                if (
                    typeof viol.start_line_no === 'number' &&
                    typeof viol.description === 'string'
                ) {
                    items.push({
                        line: viol.start_line_no,
                        column:
                            typeof viol.start_line_pos === 'number'
                                ? viol.start_line_pos
                                : undefined,
                        message: viol.description,
                        level: viol.warning === true ? 'warning' : undefined,
                    });
                }
            }
            continue;
        }

        // Ruff: [{message, location: {row, column}}]
        if (
            typeof obj.message === 'string' &&
            typeof obj.location === 'object' &&
            obj.location !== null
        ) {
            const loc = obj.location as Record<string, unknown>;
            if (typeof loc.row === 'number') {
                items.push({
                    line: loc.row,
                    column: typeof loc.column === 'number' ? loc.column : undefined,
                    message: obj.message,
                    level: typeof obj.level === 'string' ? obj.level : undefined,
                    severity: obj.severity,
                });
                continue;
            }
        }

        items.push(entry);
    }
    return items;
}

export function parseJsonOutput(stdout: string, source: string): vscode.Diagnostic[] {
    let raw: unknown;
    try {
        raw = JSON.parse(stdout);
    } catch (err) {
        console.error(`[LintRunner] JSON parse failed for source '${source}': ${String(err)}`);
        return [];
    }

    if (!Array.isArray(raw)) {
        return [];
    }

    return normalizeRawItems(raw)
        .filter(isRawItem)
        .map((item) => {
            const line = Math.max(0, item.line - 1);
            const col = Math.max(0, (item.column ?? 1) - 1);
            const range = new vscode.Range(line, col, line, col + 1);
            const severity = parseSeverity(item.level ?? item.severity);
            const diagnostic = new vscode.Diagnostic(range, item.message, severity);
            diagnostic.source = source;
            return diagnostic;
        });
}
