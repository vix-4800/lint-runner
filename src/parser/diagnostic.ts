import * as vscode from 'vscode';

const explicitColumnDiagnostics = new WeakSet<vscode.Diagnostic>();
const explicitRangeDiagnostics = new WeakSet<vscode.Diagnostic>();

export function createDiagnostic(
    line: number,
    column: number | undefined,
    message: string,
    severity: vscode.DiagnosticSeverity,
    endLine?: number,
    endColumn?: number
): vscode.Diagnostic {
    const startCharacter = Math.max(0, column ?? 0);
    const hasExplicitRange = endLine !== undefined || endColumn !== undefined;
    const rangeEndLine = Math.max(line, endLine ?? line);
    const defaultEndCharacter = startCharacter + 1;
    const rangeEndCharacter =
        hasExplicitRange && rangeEndLine === line
            ? Math.max(defaultEndCharacter, endColumn ?? defaultEndCharacter)
            : Math.max(0, endColumn ?? defaultEndCharacter);
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, startCharacter, rangeEndLine, rangeEndCharacter),
        message,
        severity
    );
    if (column !== undefined) {
        explicitColumnDiagnostics.add(diagnostic);
    }
    if (hasExplicitRange) {
        explicitRangeDiagnostics.add(diagnostic);
    }
    return diagnostic;
}

export function diagnosticHasExplicitColumn(diagnostic: vscode.Diagnostic): boolean {
    return explicitColumnDiagnostics.has(diagnostic);
}

export function diagnosticHasExplicitRange(diagnostic: vscode.Diagnostic): boolean {
    return explicitRangeDiagnostics.has(diagnostic);
}
