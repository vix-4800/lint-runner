import * as vscode from 'vscode';
import { createDiagnostic } from './diagnostic.js';

// Matches: /path/to/file: line 4, col 11, Some message.
// or just:  line 4, col 11, Some message.   (when file path is stripped by the tool)
const LINE_RE = /^(?:.+?):\s*line\s+(\d+),\s*col\s+(\d+),\s*(.+)$/;

export function parseJsonlintOutput(
    stdout: string,
    stderr: string,
    source: string
): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];
    // @prantlf/jsonlint writes errors to stderr when --quiet is not set
    const combined = `${stdout}\n${stderr}`;

    for (const raw of combined.split('\n')) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        const m = LINE_RE.exec(line);
        if (m === null) {
            continue;
        }
        const lineNo = Math.max(0, parseInt(m[1], 10) - 1);
        const colNo = Math.max(0, parseInt(m[2], 10) - 1);
        const message = m[3].replace(/\.$/, '').trim();
        const diagnostic = createDiagnostic(
            lineNo,
            colNo,
            message,
            vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = source;
        diags.push(diagnostic);
    }

    return diags;
}
