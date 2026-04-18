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

function parseSeverity(level: string | undefined): vscode.DiagnosticSeverity {
    switch ((level ?? '').toLowerCase()) {
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

    return raw.filter(isRawItem).map((item) => {
        const line = Math.max(0, item.line - 1);
        const col = Math.max(0, (item.column ?? 1) - 1);
        const range = new vscode.Range(line, col, line, col + 1);
        const severity = parseSeverity(item.level ?? item.severity);
        const diagnostic = new vscode.Diagnostic(range, item.message, severity);
        diagnostic.source = source;
        return diagnostic;
    });
}
