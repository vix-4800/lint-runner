import * as vscode from 'vscode';
import { createDiagnostic } from './diagnostic.js';

// xmllint --noout writes errors to stderr:
//   file.xml:6: parser error : Opening and ending tag mismatch: value line 5 and item
//       </item>
//              ^
const XMLLINT_RE = /^.+?:(\d+):\s*(?:parser\s+)?(?:error|warning)\s*:\s*(.+)$/i;

export function parseXmllintOutput(stderr: string, source: string): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const raw of stderr.split('\n')) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        const m = XMLLINT_RE.exec(line);
        if (m === null) {
            continue;
        }
        const lineNo = Math.max(0, parseInt(m[1], 10) - 1);
        const message = m[2].trim();

        const severity = line.toLowerCase().includes('warning')
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Error;

        const diag = createDiagnostic(lineNo, undefined, message, severity);
        diag.source = source;
        diagnostics.push(diag);
    }

    return diagnostics;
}
