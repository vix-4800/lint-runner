import * as vscode from 'vscode';
import { createDiagnostic } from './diagnostic.js';

// yamllint --format parsable:
//   file.yml:1:1: [warning] missing document start "---" (document-start)
//   file.yml:3:1: [error] too many blank lines (1 > 0) (empty-lines)
//
// Generic "parsable" / gcc-style:
//   file:LINE:COL: SEVERITY: message
const LINE_COL_RE = /^.+?:(\d+):(\d+):\s*\[?(\w+)\]?\s*(.+)$/;

// dotenv-linter --plain:
//   .env:1 LowercaseKey: The app_name key should be in uppercase
const LINE_CODE_RE = /^.+?:(\d+)\s+([A-Za-z][\w-]*):\s*(.+)$/;

export function parseParsableOutput(stdout: string, source: string): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        const lineColMatch = LINE_COL_RE.exec(line);
        const lineCodeMatch = lineColMatch === null ? LINE_CODE_RE.exec(line) : null;
        if (lineColMatch === null && lineCodeMatch === null) {
            continue;
        }

        const lineNo = Math.max(0, parseInt(lineColMatch?.[1] ?? lineCodeMatch?.[1] ?? '1', 10) - 1);
        const colNo =
            lineColMatch === null ? undefined : Math.max(0, parseInt(lineColMatch[2], 10) - 1);
        const level = lineColMatch === null ? 'warning' : lineColMatch[3].toLowerCase();
        const code = lineCodeMatch?.[2];
        const message = (lineColMatch?.[4] ?? lineCodeMatch?.[3] ?? '').trim();

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

        const diag = createDiagnostic(lineNo, colNo, message, severity);
        diag.source = source;
        if (code !== undefined) {
            diag.code = code;
        }
        diagnostics.push(diag);
    }

    return diagnostics;
}
