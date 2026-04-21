import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    applyCommandTemplate,
    buildCommandEnv,
    collectRunnableFixers,
    normalizeDiagnosticRanges,
    parseLinterOutput,
    resolveConfiguredTargets,
    shouldRunLinter,
} from '../linterRunner.js';
import { parseAnsibleLintOutput } from '../parser/ansibleLintParser.js';
import { parseJsonOutput } from '../parser/jsonParser.js';
import { parseJsonlintOutput } from '../parser/jsonlintParser.js';
import { parseLinthtmlOutput } from '../parser/linthtmlParser.js';
import { parseParsableOutput } from '../parser/parsableParser.js';
import { parseTaploOutput } from '../parser/taploParser.js';
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

suite('Linter Runner', () => {
    test('expands command variables and leaves unknown variables unchanged', () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const filePath = path.join(workspaceRoot, 'src', 'example.test.ts');
        const workspaceFolder =
            vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath ?? '';
        const relativeFile =
            workspaceFolder === '' ? filePath : path.relative(workspaceFolder, filePath);
        const result = applyCommandTemplate(
            '${file}|${file}|${workspaceFolder}|${relativeFile}|${fileDirname}|${fileBasename}|${fileBasenameNoExtension}|${fileExtname}|${unknown}',
            filePath
        );

        assert.strictEqual(
            result,
            [
                filePath,
                filePath,
                workspaceFolder,
                relativeFile,
                path.join(workspaceRoot, 'src'),
                'example.test.ts',
                'example.test',
                '.ts',
                '${unknown}',
            ].join('|')
        );
    });

    test('unknown parser returns no diagnostics', () => {
        const diagnostics = parseLinterOutput(
            {
                name: 'unknown',
                filePatterns: ['*.html'],
                command: 'lint',
                args: ['${file}'],
                parser: 'missing-parser',
                run: 'manual',
            },
            {
                code: 1,
                stdout: '  2:1  error  message  rule-id',
                stderr: '',
            }
        );

        assert.strictEqual(diagnostics.length, 0);
    });

    test('moves diagnostics without explicit column to first non-whitespace word', async () => {
        const filePath = path.resolve(__dirname, '../../lint-test/test.php');
        const diagnostics = parseParsableOutput(
            'lint-test/test.php:5 LowercaseKey: The key should be uppercase',
            'dotenv-linter'
        );

        await normalizeDiagnosticRanges(filePath, diagnostics);

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 4);
        assert.strictEqual(diagnostics[0].range.start.character, 4);
        assert.strictEqual(diagnostics[0].range.end.character, 11);
    });

    test('extends diagnostics with explicit column to first whitespace', async () => {
        const filePath = path.resolve(__dirname, '../../lint-test/test.js');
        const diagnostics = parseJsonOutput(
            JSON.stringify([{ line: 2, column: 7, message: 'Unused variable', severity: 2 }]),
            'eslint'
        );

        await normalizeDiagnosticRanges(filePath, diagnostics);

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 1);
        assert.strictEqual(diagnostics[0].range.start.character, 6);
        assert.strictEqual(diagnostics[0].range.end.character, 12);
    });

    test('prepends shell PATH to command PATH', () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const env = buildCommandEnv(workspaceRoot);
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';

        assert.strictEqual(env[pathKey]?.split(path.delimiter)[0], workspaceRoot);
    });

    test('resolves target-first configs with shared target settings', () => {
        const targets = resolveConfiguredTargets(
            [
                {
                    name: 'PHP',
                    filePatterns: ['*.php'],
                    run: 'manual',
                    showDiagnosticCodes: false,
                    preCommands: [{ name: 'php -l', command: 'php', args: ['-l', '${file}'] }],
                    linters: [
                        {
                            name: 'PHPStan',
                            command: 'phpstan',
                            args: ['analyse', '${file}'],
                            parser: 'json',
                        },
                        {
                            name: 'PHPCS',
                            command: 'phpcs',
                            args: ['${file}'],
                            parser: 'json',
                            run: 'onSave',
                            showDiagnosticCodes: true,
                        },
                    ],
                    fixers: [
                        { name: 'phpcbf', command: 'phpcbf', args: ['${file}'], run: 'onSave' },
                    ],
                },
            ],
            []
        );

        assert.strictEqual(targets.length, 1);
        assert.strictEqual(targets[0].linters.length, 2);
        assert.strictEqual(targets[0].linters[0].run, 'manual');
        assert.strictEqual(targets[0].linters[0].showDiagnosticCodes, false);
        assert.strictEqual(targets[0].linters[1].run, 'onSave');
        assert.strictEqual(targets[0].linters[1].showDiagnosticCodes, true);
        assert.strictEqual(targets[0].preCommands.length, 1);
        assert.strictEqual(targets[0].fixers.length, 1);
        assert.strictEqual(targets[0].fixers[0].run, 'onSave');
    });

    test('resolves onOpen run mode', () => {
        const targets = resolveConfiguredTargets(
            [
                {
                    name: 'Markdown',
                    filePatterns: ['*.md'],
                    run: 'onOpen',
                    linters: [
                        {
                            name: 'markdownlint',
                            command: 'markdownlint',
                            args: ['${file}'],
                            parser: 'json',
                        },
                    ],
                },
            ],
            []
        );

        assert.strictEqual(targets[0].linters[0].run, 'onOpen');
    });

    test('runs onOpen linters again on save', () => {
        const linter = {
            name: 'markdownlint',
            filePatterns: ['*.md'],
            command: 'markdownlint',
            args: ['${file}'],
            parser: 'json',
            run: 'onOpen' as const,
        };

        assert.strictEqual(shouldRunLinter(linter, 'onOpen'), true);
        assert.strictEqual(shouldRunLinter(linter, 'onSave'), true);
    });

    test('does not run onSave linters on open', () => {
        const linter = {
            name: 'eslint',
            filePatterns: ['*.ts'],
            command: 'eslint',
            args: ['${file}'],
            parser: 'json',
            run: 'onSave' as const,
        };

        assert.strictEqual(shouldRunLinter(linter, 'onOpen'), false);
        assert.strictEqual(shouldRunLinter(linter, 'onSave'), true);
    });

    test('does not run disabled linters', () => {
        const linter = {
            name: 'eslint',
            filePatterns: ['*.ts'],
            command: 'eslint',
            args: ['${file}'],
            parser: 'json',
            run: 'onSave' as const,
            enabled: false,
        };

        assert.strictEqual(shouldRunLinter(linter, 'manual'), false);
        assert.strictEqual(shouldRunLinter(linter, 'onSave'), false);
    });

    test('keeps legacy linter-first configs working as targets', () => {
        const targets = resolveConfiguredTargets([], [
            {
                name: 'ESLint',
                filePatterns: ['*.ts'],
                command: 'eslint',
                args: ['${file}'],
                parser: 'json',
                run: 'onSave',
                fixCommand: {
                    name: 'eslint --fix',
                    command: 'eslint',
                    args: ['--fix', '${file}'],
                    run: 'onSave',
                },
            },
        ]);

        assert.strictEqual(targets.length, 1);
        assert.strictEqual(targets[0].name, 'ESLint');
        assert.deepStrictEqual(targets[0].filePatterns, ['*.ts']);
        assert.strictEqual(targets[0].linters[0].name, 'ESLint');
        assert.strictEqual(targets[0].linters[0].fixCommand?.run, 'onSave');
    });

    test('collects runnable fixers for matching targets', () => {
        const targets = resolveConfiguredTargets(
            [
                {
                    name: 'TypeScript',
                    filePatterns: ['*.ts'],
                    fixers: [
                        { name: 'prettier', command: 'prettier', args: ['--write', '${file}'] },
                        {
                            name: 'disabled prettier',
                            command: 'prettier',
                            args: ['--write', '${file}'],
                            enabled: false,
                        },
                        {
                            name: 'eslint --fix',
                            command: 'eslint',
                            args: ['--fix', '${file}'],
                            run: 'onSave',
                        },
                    ],
                    linters: [
                        {
                            name: 'ESLint',
                            command: 'eslint',
                            args: ['${file}'],
                            parser: 'json',
                            fixCommand: {
                                name: 'eslint legacy --fix',
                                command: 'eslint',
                                args: ['--fix', '${file}'],
                            },
                        },
                        {
                            name: 'Disabled ESLint',
                            command: 'eslint',
                            args: ['${file}'],
                            parser: 'json',
                            fixCommand: {
                                name: 'disabled legacy --fix',
                                command: 'eslint',
                                args: ['--fix', '${file}'],
                                enabled: false,
                            },
                        },
                    ],
                },
            ],
            []
        );

        const manualFixers = collectRunnableFixers(targets, '/tmp/example.ts', 'manual');
        assert.deepStrictEqual(
            manualFixers.map((fixer) => fixer.label),
            ['prettier', 'eslint --fix', 'eslint legacy --fix']
        );
        assert.deepStrictEqual(
            manualFixers.map((fixer) => fixer.description),
            ['TypeScript', 'TypeScript', 'TypeScript / ESLint']
        );

        const onSaveFixers = collectRunnableFixers(targets, '/tmp/example.ts', 'onSave');
        assert.deepStrictEqual(
            onSaveFixers.map((fixer) => fixer.label),
            ['eslint --fix']
        );
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

    test('parses dotenv-linter plain output', () => {
        const input =
            'lint-test/.env:1 LowercaseKey: The app_name key should be in uppercase\nlint-test/.env:2 IncorrectDelimiter: The APP ENV key has incorrect delimiter';
        const diags = parseParsableOutput(input, 'dotenv-linter');
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diags[0].range.start.line, 0);
        assert.strictEqual(diags[0].range.start.character, 0);
        assert.strictEqual(diags[0].message, 'The app_name key should be in uppercase');
        assert.strictEqual(diags[0].code, 'LowercaseKey');
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

suite('Taplo Parser', () => {
    test('parses syntax error output', () => {
        const input = [
            'error: invalid TOML',
            '  ┌─ /tmp/test.toml:1:5',
            '  │',
            '1 │ x = ]',
            '  │     ^ expected value',
            '',
            'ERROR invalid file error=syntax errors found path="/tmp/test.toml"',
        ].join('\n');

        const diags = parseTaploOutput(input, 'taplo');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 0);
        assert.strictEqual(diags[0].range.start.character, 4);
        assert.strictEqual(diags[0].message, 'invalid TOML: expected value');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[0].source, 'taplo');
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
