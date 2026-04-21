import * as vscode from 'vscode';

const explicitColumnDiagnostics = new WeakSet<vscode.Diagnostic>();

export function createDiagnostic(
    line: number,
    column: number | undefined,
    message: string,
    severity: vscode.DiagnosticSeverity
): vscode.Diagnostic {
    const startCharacter = Math.max(0, column ?? 0);
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, startCharacter, line, startCharacter + 1),
        message,
        severity
    );
    if (column !== undefined) {
        explicitColumnDiagnostics.add(diagnostic);
    }
    return diagnostic;
}

export function diagnosticHasExplicitColumn(diagnostic: vscode.Diagnostic): boolean {
    return explicitColumnDiagnostics.has(diagnostic);
}
