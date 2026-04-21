import * as vscode from 'vscode';
import { createDiagnostic } from './diagnostic.js';

// ansible-lint text output format (default / --format full):
//
//   rule-id: Short description.
//   path/to/file.yml:LINE[:COL] Detail message.
//   <blank line>
//   ...

const RULE_LINE_RE = /^([\w[\].-]+):\s+(.+)$/;
const LOCATION_LINE_RE = /^.+?:(\d+)(?::(\d+))?(?:\s+(.*))?$/;

export function parseAnsibleLintOutput(stdout: string, source: string): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const lines = stdout.split('\n');

    let i = 0;
    while (i < lines.length) {
        const ruleLine = lines[i].trim();

        if (!ruleLine) {
            i++;
            continue;
        }

        const ruleMatch = RULE_LINE_RE.exec(ruleLine);
        if (ruleMatch !== null && i + 1 < lines.length) {
            const ruleId = ruleMatch[1];
            const ruleDesc = ruleMatch[2];
            const locationLine = lines[i + 1].trim();
            const locMatch = LOCATION_LINE_RE.exec(locationLine);

            if (locMatch !== null) {
                const lineNo = Math.max(0, parseInt(locMatch[1], 10) - 1);
                const colNo =
                    locMatch[2] !== undefined
                        ? Math.max(0, parseInt(locMatch[2], 10) - 1)
                        : undefined;
                const detail = locMatch[3]?.trim();
                const message = detail ? `${ruleId}: ${detail}` : `${ruleId}: ${ruleDesc}`;

                const diag = createDiagnostic(
                    lineNo,
                    colNo,
                    message,
                    vscode.DiagnosticSeverity.Warning
                );
                diag.source = source;
                diag.code = ruleId;
                diagnostics.push(diag);

                i += 2;
                continue;
            }
        }

        i++;
    }

    return diagnostics;
}
