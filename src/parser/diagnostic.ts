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
    const defaultEndCharacter = startCharacter + 1;
    const hasRequestedExplicitRange = endLine !== undefined || endColumn !== undefined;
    const candidateEndLine = Math.max(0, endLine ?? line);
    const candidateEndCharacter = Math.max(0, endColumn ?? defaultEndCharacter);
    const hasValidExplicitRange =
        hasRequestedExplicitRange &&
        (candidateEndLine > line ||
            (candidateEndLine === line && candidateEndCharacter > startCharacter));
    const rangeEndLine = hasValidExplicitRange ? candidateEndLine : line;
    const rangeEndCharacter = hasValidExplicitRange ? candidateEndCharacter : defaultEndCharacter;
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, startCharacter, rangeEndLine, rangeEndCharacter),
        message,
        severity
    );
    if (column !== undefined) {
        explicitColumnDiagnostics.add(diagnostic);
    }
    if (hasValidExplicitRange) {
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
