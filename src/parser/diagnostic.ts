import * as vscode from 'vscode';

const explicitColumnDiagnostics = new WeakSet<vscode.Diagnostic>();
const explicitRangeDiagnostics = new WeakSet<vscode.Diagnostic>();

function resolveDiagnosticRangeEnd(
    line: number,
    startCharacter: number,
    endLine: number | undefined,
    endColumn: number | undefined
): { endLine: number; endCharacter: number; hasExplicitRange: boolean } {
    const defaultEndCharacter = startCharacter + 1;
    const hasAnyEndPosition = endLine !== undefined || endColumn !== undefined;
    const candidateEndLine = Math.max(0, endLine ?? line);
    const candidateEndCharacter = Math.max(0, endColumn ?? defaultEndCharacter);
    const hasExplicitRange =
        hasAnyEndPosition &&
        (candidateEndLine > line ||
            (candidateEndLine === line && candidateEndCharacter > startCharacter));

    return {
        endLine: hasExplicitRange ? candidateEndLine : line,
        endCharacter: hasExplicitRange ? candidateEndCharacter : defaultEndCharacter,
        hasExplicitRange,
    };
}

export function createDiagnostic(
    line: number,
    column: number | undefined,
    message: string,
    severity: vscode.DiagnosticSeverity,
    endLine?: number,
    endColumn?: number
): vscode.Diagnostic {
    const startCharacter = Math.max(0, column ?? 0);
    const rangeEnd = resolveDiagnosticRangeEnd(line, startCharacter, endLine, endColumn);
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, startCharacter, rangeEnd.endLine, rangeEnd.endCharacter),
        message,
        severity
    );
    if (column !== undefined) {
        explicitColumnDiagnostics.add(diagnostic);
    }
    if (rangeEnd.hasExplicitRange) {
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
