import * as vscode from 'vscode';

// linthtml --no-color output:
//  2:1  error  <HTML> tag should specify the language  html-req-lang
//  8:9  error  Invalid case for tag <h1>               tag-name-lowercase
const LINTHTML_RE = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/;

export function parseLinthtmlOutput(stdout: string, source: string): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const raw of stdout.split('\n')) {
        const m = LINTHTML_RE.exec(raw);
        if (m === null) {
            continue;
        }
        const lineNo = Math.max(0, parseInt(m[1], 10) - 1);
        const colNo = Math.max(0, parseInt(m[2], 10) - 1);
        const level = m[3];
        const message = m[4].trim();
        const rule = m[5];

        const severity =
            level === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;

        const range = new vscode.Range(lineNo, colNo, lineNo, colNo + 1);
        const diag = new vscode.Diagnostic(range, message, severity);
        diag.source = source;
        diag.code = rule;
        diagnostics.push(diag);
    }

    return diagnostics;
}
