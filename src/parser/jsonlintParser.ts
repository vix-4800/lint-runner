import * as vscode from 'vscode';
import { createDiagnostic } from './diagnostic.js';

// Matches: /path/to/file: line 4, col 11, Some message.
// or just:  line 4, col 11, Some message.   (when file path is stripped by the tool)
const LINE_RE = /^(?:.+?):\s*line\s+(\d+),\s*col\s+(\d+),\s*(.+)$/;
const PARSE_ERROR_RE = /^Parse error on line (\d+), column (\d+):$/;

export function parseJsonlintOutput(
    stdout: string,
    stderr: string,
    source: string
): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];
    // @prantlf/jsonlint writes errors to stderr when --quiet is not set
    const combined = `${stdout}\n${stderr}`;
    let pendingLocation: { line: number; column: number } | undefined;

    for (const raw of combined.split('\n')) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        const m = LINE_RE.exec(line);
        if (m === null) {
            const parseErrorMatch = PARSE_ERROR_RE.exec(line);
            if (parseErrorMatch !== null) {
                pendingLocation = {
                    line: Math.max(0, parseInt(parseErrorMatch[1], 10) - 1),
                    column: Math.max(0, parseInt(parseErrorMatch[2], 10) - 1),
                };
                continue;
            }
            if (
                pendingLocation !== undefined &&
                !line.startsWith('File:') &&
                !line.startsWith('...') &&
                !/^-+\^$/.test(line)
            ) {
                const diagnostic = createDiagnostic(
                    pendingLocation.line,
                    pendingLocation.column,
                    line.replace(/\.$/, '').trim(),
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.source = source;
                diags.push(diagnostic);
                pendingLocation = undefined;
            }
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
        pendingLocation = undefined;
    }

    return diags;
}
