import * as vscode from 'vscode';

// yamllint --format parsable:
//   file.yml:1:1: [warning] missing document start "---" (document-start)
//   file.yml:3:1: [error] too many blank lines (1 > 0) (empty-lines)
//
// Generic "parsable" / gcc-style:
//   file:LINE:COL: SEVERITY: message
const PARSABLE_RE = /^.+?:(\d+):(\d+):\s*\[?(\w+)\]?\s*(.+)$/;

export function parseParsableOutput(stdout: string, source: string): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        const m = PARSABLE_RE.exec(line);
        if (m === null) {
            continue;
        }
        const lineNo = Math.max(0, parseInt(m[1], 10) - 1);
        const colNo = Math.max(0, parseInt(m[2], 10) - 1);
        const level = m[3].toLowerCase();
        const message = m[4].trim();

        let severity: vscode.DiagnosticSeverity;
        switch (level) {
            case 'error':
                severity = vscode.DiagnosticSeverity.Error;
                break;
            case 'info':
            case 'information':
                severity = vscode.DiagnosticSeverity.Information;
                break;
            default:
                severity = vscode.DiagnosticSeverity.Warning;
                break;
        }

        const range = new vscode.Range(lineNo, colNo, lineNo, colNo + 1);
        const diag = new vscode.Diagnostic(range, message, severity);
        diag.source = source;
        diagnostics.push(diag);
    }

    return diagnostics;
}
