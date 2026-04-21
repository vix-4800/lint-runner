import * as vscode from 'vscode';
import { createDiagnostic } from './diagnostic.js';

const MESSAGE_RE = /^(error|warning|warn|info|information):\s*(.+)$/i;
const LOCATION_RE = /^\s*\S+\s+(.+):(\d+):(\d+)\s*$/;
const DETAIL_RE = /^\s*\S+\s+\^+\s*(.*)$/;

interface PendingDiagnostic {
    message: string;
    severity: vscode.DiagnosticSeverity;
}

interface LastDiagnostic {
    diagnostic: vscode.Diagnostic;
    message: string;
}

function taploSeverity(level: string): vscode.DiagnosticSeverity {
    switch (level.toLowerCase()) {
        case 'error':
            return vscode.DiagnosticSeverity.Error;
        case 'info':
        case 'information':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Warning;
    }
}

export function parseTaploOutput(output: string, source: string): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    let pending: PendingDiagnostic | undefined;
    let last: LastDiagnostic | undefined;

    for (const raw of output.split('\n')) {
        const line = raw.trimEnd();
        if (line.trim() === '') {
            continue;
        }

        const messageMatch = MESSAGE_RE.exec(line.trim());
        if (messageMatch !== null) {
            pending = {
                severity: taploSeverity(messageMatch[1]),
                message: messageMatch[2].trim(),
            };
            last = undefined;
            continue;
        }

        const locationMatch = LOCATION_RE.exec(line);
        if (locationMatch !== null && pending !== undefined) {
            const lineNo = Math.max(0, parseInt(locationMatch[2], 10) - 1);
            const colNo = Math.max(0, parseInt(locationMatch[3], 10) - 1);
            const diagnostic = createDiagnostic(lineNo, colNo, pending.message, pending.severity);
            diagnostic.source = source;
            diagnostics.push(diagnostic);
            last = { diagnostic, message: pending.message };
            pending = undefined;
            continue;
        }

        const detailMatch = DETAIL_RE.exec(line);
        const detail = detailMatch?.[1].trim();
        if (detail !== undefined && detail !== '' && last !== undefined) {
            last.diagnostic.message = `${last.message}: ${detail}`;
        }
    }

    return diagnostics;
}
