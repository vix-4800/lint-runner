import * as vscode from 'vscode';

interface RawItem {
    line: number;
    column?: number;
    col?: number;
    message: string;
    level?: string;
    severity?: number | string;
    code?: string;
    rule?: string | { id?: unknown };
    ruleId?: string;
    source?: string;
    type?: string;
}

function isRawItem(value: unknown): value is RawItem {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const v = value as Record<string, unknown>;
    return typeof v.line === 'number' && typeof v.message === 'string';
}

function parseSeverity(level: unknown): vscode.DiagnosticSeverity {
    if (typeof level === 'number') {
        if (level >= 2) {
            return vscode.DiagnosticSeverity.Error;
        }
        if (level === 1) {
            return vscode.DiagnosticSeverity.Warning;
        }
        return vscode.DiagnosticSeverity.Information;
    }
    switch (String(level ?? '').toLowerCase()) {
        case 'error':
            return vscode.DiagnosticSeverity.Error;
        case 'info':
        case 'information':
        case 'hint':
        case 'style':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Warning;
    }
}

function extractItemsFromObject(obj: Record<string, unknown>): unknown[] {
    const items: unknown[] = [];

    // phpstan / phpcs: {files: {"/path": {messages: [...]}}}
    if (typeof obj.files === 'object' && obj.files !== null && !Array.isArray(obj.files)) {
        const files = obj.files as Record<string, unknown>;
        for (const fileData of Object.values(files)) {
            if (typeof fileData !== 'object' || fileData === null) {
                continue;
            }
            const fd = fileData as Record<string, unknown>;
            if (Array.isArray(fd.messages)) {
                items.push(...fd.messages);
            }
        }
        return items;
    }

    // phpmd: {files: [{file, violations: [...]}]}
    if (Array.isArray(obj.files)) {
        for (const entry of obj.files) {
            if (typeof entry !== 'object' || entry === null) {
                continue;
            }
            const e = entry as Record<string, unknown>;
            if (Array.isArray(e.violations)) {
                items.push(...e.violations);
            }
        }
        return items;
    }

    return items;
}

function normalizeRawItems(raw: unknown[]): unknown[] {
    const items: unknown[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const obj = entry as Record<string, unknown>;

        // ESLint: [{messages: [{line, column, message, severity}]}]
        if (Array.isArray(obj.messages)) {
            for (const msg of obj.messages) {
                if (typeof msg !== 'object' || msg === null) {
                    continue;
                }
                const m = msg as Record<string, unknown>;
                // Fatal ESLint errors may lack 'line'
                if (typeof m.line !== 'number') {
                    m.line = 1;
                }
                if (typeof m.column !== 'number' && typeof m.col === 'number') {
                    m.column = m.col;
                }
                if (
                    typeof m.rule !== 'string' &&
                    typeof m.rule === 'object' &&
                    m.rule !== null &&
                    typeof (m.rule as Record<string, unknown>).id === 'string'
                ) {
                    m.code = (m.rule as Record<string, unknown>).id;
                }
                items.push(m);
            }
            continue;
        }

        // Stylelint parse errors: [{parseErrors: [{line, column, text, type}]}]
        if (Array.isArray(obj.parseErrors)) {
            for (const p of obj.parseErrors) {
                if (typeof p !== 'object' || p === null) {
                    continue;
                }
                const parseError = p as Record<string, unknown>;
                if (typeof parseError.text === 'string') {
                    items.push({
                        line: parseError.line,
                        column: parseError.column,
                        message: parseError.text,
                        level: parseError.type,
                        code: parseError.stylelintType,
                    });
                }
            }
        }

        // Stylelint: [{warnings: [{line, column, text, severity, rule}]}]
        if (Array.isArray(obj.warnings)) {
            for (const w of obj.warnings) {
                if (typeof w !== 'object' || w === null) {
                    continue;
                }
                const warn = w as Record<string, unknown>;
                if (typeof warn.text === 'string') {
                    items.push({
                        line: warn.line,
                        column: warn.column,
                        message: warn.text,
                        level: warn.severity,
                        code: warn.rule,
                    });
                }
            }
            continue;
        }

        // SQLFluff: [{violations: [{start_line_no, start_line_pos, description}]}]
        if (Array.isArray(obj.violations)) {
            for (const v of obj.violations) {
                if (typeof v !== 'object' || v === null) {
                    continue;
                }
                const viol = v as Record<string, unknown>;
                if (
                    typeof viol.start_line_no === 'number' &&
                    typeof viol.description === 'string'
                ) {
                    items.push({
                        line: viol.start_line_no,
                        column:
                            typeof viol.start_line_pos === 'number'
                                ? viol.start_line_pos
                                : undefined,
                        message: viol.description,
                        level: viol.warning === true ? 'warning' : undefined,
                    });
                }
            }
            continue;
        }

        // Ruff: [{message, location: {row, column}}]
        if (
            typeof obj.message === 'string' &&
            typeof obj.location === 'object' &&
            obj.location !== null
        ) {
            const loc = obj.location as Record<string, unknown>;
            if (typeof loc.row === 'number') {
                items.push({
                    line: loc.row,
                    column: typeof loc.column === 'number' ? loc.column : undefined,
                    message: obj.message,
                    level: typeof obj.level === 'string' ? obj.level : undefined,
                    severity: obj.severity,
                    code: obj.code,
                });
                continue;
            }
        }

        // checkmake: [{line_number, rule, violation}]
        if (typeof obj.line_number === 'number' && typeof obj.violation === 'string') {
            items.push({
                line: obj.line_number,
                message: `${String(obj.rule ?? '')}: ${obj.violation}`.replace(/^:\s*/, ''),
                code: obj.rule,
            });
            continue;
        }

        // markdownlint: [{lineNumber, ruleDescription, ruleNames, errorDetail}]
        if (typeof obj.lineNumber === 'number' && typeof obj.ruleDescription === 'string') {
            const ruleNames = Array.isArray(obj.ruleNames) ? obj.ruleNames : [];
            const ruleId = typeof ruleNames[0] === 'string' ? ruleNames[0] : undefined;
            const detail = typeof obj.errorDetail === 'string' ? `: ${obj.errorDetail}` : '';
            items.push({
                line: obj.lineNumber,
                column:
                    Array.isArray(obj.errorRange) && typeof obj.errorRange[0] === 'number'
                        ? obj.errorRange[0]
                        : undefined,
                message: `${obj.ruleDescription}${detail}`,
                level: obj.severity,
                code: ruleId,
            });
            continue;
        }

        // phpmd violations: {beginLine, description, rule}
        if (typeof obj.beginLine === 'number' && typeof obj.description === 'string') {
            items.push({
                line: obj.beginLine,
                message: obj.description,
                code: obj.rule,
                level: typeof obj.priority === 'number' && obj.priority <= 2 ? 'error' : 'warning',
            });
            continue;
        }

        // phpcs messages: {line, column, message, type, source}
        if (
            typeof obj.line === 'number' &&
            typeof obj.message === 'string' &&
            typeof obj.type === 'string'
        ) {
            items.push({
                line: obj.line,
                column: obj.column,
                message: obj.message,
                level: obj.type,
                code: obj.source,
            });
            continue;
        }

        items.push(entry);
    }
    return items;
}

export function parseJsonOutput(stdout: string, source: string): vscode.Diagnostic[] {
    const trimmed = stdout.trim();
    if (trimmed === '') {
        return [];
    }

    let raw: unknown;
    try {
        raw = JSON.parse(trimmed);
    } catch {
        return [];
    }

    let flatItems: unknown[];
    if (Array.isArray(raw)) {
        flatItems = normalizeRawItems(raw);
    } else if (typeof raw === 'object' && raw !== null) {
        const extracted = extractItemsFromObject(raw as Record<string, unknown>);
        flatItems = normalizeRawItems(extracted);
    } else {
        return [];
    }

    return flatItems.filter(isRawItem).map((item) => {
        const line = Math.max(0, item.line - 1);
        const col = Math.max(0, (item.column ?? item.col ?? 1) - 1);
        const range = new vscode.Range(line, col, line, col + 1);
        const severity = parseSeverity(item.level ?? item.severity ?? item.type);
        const diagnostic = new vscode.Diagnostic(range, item.message, severity);
        diagnostic.source = source;
        const nestedRuleId =
            typeof item.rule === 'object' && item.rule !== null && typeof item.rule.id === 'string'
                ? item.rule.id
                : undefined;
        const code = item.code ?? (typeof item.rule === 'string' ? item.rule : undefined) ?? item.ruleId ?? nestedRuleId;
        if (code !== undefined) {
            diagnostic.code = String(code);
        }
        return diagnostic;
    });
}
