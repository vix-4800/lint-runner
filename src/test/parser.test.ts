import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseAnsibleLintOutput } from '../parser/ansibleLintParser.js';
import { parseJsonOutput } from '../parser/jsonParser.js';
import { parseJsonlintOutput } from '../parser/jsonlintParser.js';
import { parseLinthtmlOutput } from '../parser/linthtmlParser.js';
import { parseParsableOutput } from '../parser/parsableParser.js';
import { parseXmllintOutput } from '../parser/xmllintParser.js';

suite('JSON Parser', () => {
    test('empty input returns no diagnostics', () => {
        assert.strictEqual(parseJsonOutput('', 'test').length, 0);
        assert.strictEqual(parseJsonOutput('   ', 'test').length, 0);
    });

    test('phpcs format', () => {
        const input = JSON.stringify({
            files: {
                '/tmp/test.php': {
                    messages: [
                        {
                            line: 5,
                            column: 1,
                            message: 'Missing newline',
                            type: 'error',
                            source: 'PSR2.Files.EndFileNewline',
                        },
                    ],
                },
            },
        });
        const diags = parseJsonOutput(input, 'phpcs');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'Missing newline');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[0].source, 'phpcs');
        assert.strictEqual(diags[0].code, 'PSR2.Files.EndFileNewline');
        assert.strictEqual(diags[0].range.start.line, 4);
        assert.strictEqual(diags[0].range.start.character, 0);
    });

    test('eslint format', () => {
        const input = JSON.stringify([
            {
                messages: [
                    {
                        line: 3,
                        column: 7,
                        message: 'Unused variable',
                        severity: 2,
                        ruleId: 'no-unused-vars',
                    },
                    {
                        line: 10,
                        column: 1,
                        message: 'Use const',
                        severity: 1,
                        ruleId: 'prefer-const',
                    },
                ],
            },
        ]);
        const diags = parseJsonOutput(input, 'eslint');
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[0].code, 'no-unused-vars');
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Warning);
    });

    test('stylelint warnings format', () => {
        const input = JSON.stringify([
            {
                parseErrors: [],
                warnings: [
                    {
                        line: 2,
                        column: 5,
                        text: 'Unexpected color',
                        severity: 'error',
                        rule: 'color-no-invalid-hex',
                    },
                ],
            },
        ]);
        const diags = parseJsonOutput(input, 'stylelint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'Unexpected color');
        assert.strictEqual(diags[0].code, 'color-no-invalid-hex');
    });

    test('stylelint parseErrors format', () => {
        const input = JSON.stringify([
            {
                parseErrors: [{ line: 1, column: 10, text: 'Unexpected token', type: 'error' }],
                warnings: [],
            },
        ]);
        const diags = parseJsonOutput(input, 'stylelint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'Unexpected token');
    });

    test('stylelint combined parseErrors and warnings', () => {
        const input = JSON.stringify([
            {
                parseErrors: [{ line: 1, column: 1, text: 'Parse error', type: 'error' }],
                warnings: [
                    {
                        line: 5,
                        column: 3,
                        text: 'Named color',
                        severity: 'warning',
                        rule: 'color-named',
                    },
                ],
            },
        ]);
        const diags = parseJsonOutput(input, 'stylelint');
        assert.strictEqual(diags.length, 2);
    });

    test('ruff format', () => {
        const input = JSON.stringify([
            { message: 'Unused import', location: { row: 1, column: 8 }, code: 'F401' },
        ]);
        const diags = parseJsonOutput(input, 'ruff');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'Unused import');
        assert.strictEqual(diags[0].code, 'F401');
        assert.strictEqual(diags[0].range.start.line, 0);
        assert.strictEqual(diags[0].range.start.character, 7);
    });

    test('sqlfluff format', () => {
        const input = JSON.stringify([
            {
                violations: [
                    { start_line_no: 1, start_line_pos: 1, description: 'Use uppercase keywords' },
                ],
            },
        ]);
        const diags = parseJsonOutput(input, 'sqlfluff');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'Use uppercase keywords');
    });

    test('checkmake format', () => {
        const input = JSON.stringify([
            { line_number: 3, rule: 'minphony', violation: 'Missing .PHONY' },
        ]);
        const diags = parseJsonOutput(input, 'checkmake');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'minphony: Missing .PHONY');
        assert.strictEqual(diags[0].range.start.line, 2);
    });

    test('markdownlint format', () => {
        const input = JSON.stringify([
            {
                lineNumber: 5,
                ruleDescription: 'Heading style',
                ruleNames: ['MD003'],
                errorDetail: 'setext',
            },
        ]);
        const diags = parseJsonOutput(input, 'markdownlint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'Heading style: setext');
        assert.strictEqual(diags[0].code, 'MD003');
    });

    test('phpmd format', () => {
        const input = JSON.stringify({
            files: [
                {
                    violations: [
                        {
                            beginLine: 7,
                            description: 'Unused variable',
                            rule: 'UnusedLocalVariable',
                            priority: 3,
                        },
                    ],
                },
            ],
        });
        const diags = parseJsonOutput(input, 'phpmd');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'Unused variable');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
    });

    test('skips preamble text before JSON', () => {
        const input = 'Some debug output\n[{"line": 1, "column": 1, "message": "test"}]';
        const diags = parseJsonOutput(input, 'test');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'test');
    });

    test('invalid JSON returns empty', () => {
        assert.strictEqual(parseJsonOutput('not json at all', 'test').length, 0);
    });
});

suite('Jsonlint Parser', () => {
    test('empty input returns no diagnostics', () => {
        assert.strictEqual(parseJsonlintOutput('', '', 'test').length, 0);
    });

    test('parses jsonlint error from stderr', () => {
        const stderr = '/tmp/test.json: line 4, col 11, found: STRING expected: EOF.';
        const diags = parseJsonlintOutput('', stderr, 'jsonlint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 3);
        assert.strictEqual(diags[0].range.start.character, 10);
        assert.strictEqual(diags[0].message, 'found: STRING expected: EOF');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('strips trailing period', () => {
        const stderr = 'test.json: line 1, col 1, Duplicate key.';
        const diags = parseJsonlintOutput('', stderr, 'jsonlint');
        assert.strictEqual(diags[0].message, 'Duplicate key');
    });
});

suite('Parsable Parser', () => {
    test('empty input returns no diagnostics', () => {
        assert.strictEqual(parseParsableOutput('', 'test').length, 0);
    });

    test('parses yamllint-style output', () => {
        const input =
            'file.yml:1:1: [warning] missing document start "---" (document-start)\nfile.yml:3:1: [error] too many blank lines (empty-lines)';
        const diags = parseParsableOutput(input, 'yamllint');
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diags[0].range.start.line, 0);
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Error);
    });

    test('parses gcc-style without brackets', () => {
        const input = 'main.c:10:5: error unexpected token';
        const diags = parseParsableOutput(input, 'gcc');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('info severity', () => {
        const input = 'file:1:1: [info] some note';
        const diags = parseParsableOutput(input, 'test');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Information);
    });
});

suite('Xmllint Parser', () => {
    test('empty input returns no diagnostics', () => {
        assert.strictEqual(parseXmllintOutput('', 'test').length, 0);
    });

    test('parses parser error', () => {
        const stderr = 'file.xml:6: parser error : Opening and ending tag mismatch';
        const diags = parseXmllintOutput(stderr, 'xmllint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 5);
        assert.strictEqual(diags[0].message, 'Opening and ending tag mismatch');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('parses warning', () => {
        const stderr = 'file.xml:2: warning : xmlns: URI is not absolute';
        const diags = parseXmllintOutput(stderr, 'xmllint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
    });

    test('skips non-matching lines', () => {
        const stderr = '      ^  \nfile.xml:6: parser error : Something';
        const diags = parseXmllintOutput(stderr, 'xmllint');
        assert.strictEqual(diags.length, 1);
    });
});

suite('Linthtml Parser', () => {
    test('empty input returns no diagnostics', () => {
        assert.strictEqual(parseLinthtmlOutput('', 'test').length, 0);
    });

    test('parses error line', () => {
        const input = '  2:1  error  <HTML> tag should specify the language  html-req-lang';
        const diags = parseLinthtmlOutput(input, 'linthtml');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 1);
        assert.strictEqual(diags[0].range.start.character, 0);
        assert.strictEqual(diags[0].message, '<HTML> tag should specify the language');
        assert.strictEqual(diags[0].code, 'html-req-lang');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('parses warning line', () => {
        const input = '  8:9  warning  Invalid case for tag  tag-name-lowercase';
        const diags = parseLinthtmlOutput(input, 'linthtml');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
    });
});

suite('Ansible-lint Parser', () => {
    test('empty input returns no diagnostics', () => {
        assert.strictEqual(parseAnsibleLintOutput('', 'test').length, 0);
    });

    test('parses rule + location pair', () => {
        const input =
            'command-instead-of-shell: Use command instead of shell.\nplaybook.yml:10 Use command module';
        const diags = parseAnsibleLintOutput(input, 'ansible-lint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 9);
        assert.strictEqual(diags[0].message, 'command-instead-of-shell: Use command module');
        assert.strictEqual(diags[0].code, 'command-instead-of-shell');
    });

    test('parses with column', () => {
        const input = 'yaml[truthy]: Truthy value.\nfile.yml:3:5 Some detail';
        const diags = parseAnsibleLintOutput(input, 'ansible-lint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 2);
        assert.strictEqual(diags[0].range.start.character, 4);
    });

    test('falls back to rule description when no detail', () => {
        const input = 'no-changed-when: Commands should not change things.\nplaybook.yml:7';
        const diags = parseAnsibleLintOutput(input, 'ansible-lint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'no-changed-when: Commands should not change things.');
    });

    test('skips orphan lines', () => {
        const input = '\nsome random line\n\nrule-id: Desc.\nfile.yml:1 msg';
        const diags = parseAnsibleLintOutput(input, 'ansible-lint');
        assert.strictEqual(diags.length, 1);
    });

    test('multiple pairs', () => {
        const input = 'rule-a: Desc A.\nfile.yml:1 msg A\n\nrule-b: Desc B.\nfile.yml:5 msg B';
        const diags = parseAnsibleLintOutput(input, 'ansible-lint');
        assert.strictEqual(diags.length, 2);
    });
});
