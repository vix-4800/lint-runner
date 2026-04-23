import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    applyCommandTemplate,
    collectRunnableLinters,
    buildCommandEnv,
    collectRunnableFixers,
    matchesIgnorePatterns,
    normalizeDiagnosticRanges,
    parseLinterOutput,
    resolveConfiguredTargets,
    shouldRunLinter,
    type LinterConfig,
    type RegexParserConfig,
} from '../linterRunner.js';
import { parseAnsibleLintOutput } from '../parser/ansibleLintParser.js';
import { parseJsonOutput } from '../parser/jsonParser.js';
import { parseJsonlintOutput } from '../parser/jsonlintParser.js';
import { parseLinthtmlOutput } from '../parser/linthtmlParser.js';
import { parseParsableOutput } from '../parser/parsableParser.js';
import { parseTaploOutput } from '../parser/taploParser.js';
import { parseXmllintOutput } from '../parser/xmllintParser.js';

function parseRegexFixture(
    name: string,
    parser: RegexParserConfig,
    stdout: string,
    stderr = ''
): vscode.Diagnostic[] {
    return parseLinterOutput(
        {
            name,
            filePatterns: ['*'],
            command: 'test',
            args: [],
            parser,
            run: 'manual',
        },
        { code: 1, stdout, stderr }
    );
}

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

    test('shellcheck json format', () => {
        const input = JSON.stringify([
            {
                file: 'lint-test/test.sh',
                line: 7,
                endLine: 7,
                column: 16,
                endColumn: 21,
                level: 'info',
                code: 2086,
                message: 'Double quote to prevent globbing and word splitting.',
            },
            {
                file: 'lint-test/test.sh',
                line: 7,
                endLine: 7,
                column: 16,
                endColumn: 21,
                level: 'style',
                code: 2250,
                message: 'Prefer putting braces around variable references even when not strictly required.',
            },
        ]);
        const diags = parseJsonOutput(input, 'shellcheck');
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Information);
        assert.strictEqual(diags[0].code, '2086');
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Information);
        assert.strictEqual(diags[1].code, '2250');
    });

    test('sqlfluff format', () => {
        const input = JSON.stringify([
            {
                violations: [
                    {
                        start_line_no: 1,
                        start_line_pos: 1,
                        code: 'CP01',
                        description: 'Use uppercase keywords',
                    },
                ],
            },
        ]);
        const diags = parseJsonOutput(input, 'sqlfluff');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'Use uppercase keywords');
        assert.strictEqual(diags[0].code, 'CP01');
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

    test('hadolint format', () => {
        const input = JSON.stringify([
            {
                code: 'DL3007',
                column: 1,
                file: 'lint-test/Dockerfile',
                level: 'warning',
                line: 4,
                message:
                    'Using latest is prone to errors if the image will ever update. Pin the version explicitly to a release tag',
            },
            {
                code: 'DL3049',
                column: 1,
                file: 'lint-test/Dockerfile',
                level: 'info',
                line: 4,
                message: 'Label `author` is missing.',
            },
            {
                code: 'DL3025',
                column: 1,
                file: 'lint-test/Dockerfile',
                level: 'error',
                line: 12,
                message: 'Use arguments JSON notation for CMD and ENTRYPOINT arguments',
            },
        ]);
        const diags = parseJsonOutput(input, 'hadolint');
        assert.strictEqual(diags.length, 3);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Information);
        assert.strictEqual(diags[2].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[2].code, 'DL3025');
    });

    test('htmlhint format', () => {
        const input = JSON.stringify([
            {
                file: 'lint-test/test.html',
                messages: [
                    {
                        type: 'warning',
                        message: 'An lang attribute must be present on <html> elements.',
                        line: 2,
                        col: 6,
                        rule: { id: 'html-lang-require' },
                    },
                    {
                        type: 'error',
                        message: 'The html element name of [ H1 ] must be in lowercase.',
                        line: 8,
                        col: 9,
                        rule: { id: 'tagname-lowercase' },
                    },
                ],
            },
        ]);
        const diags = parseJsonOutput(input, 'htmlhint');
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diags[0].code, 'html-lang-require');
        assert.strictEqual(diags[0].range.start.character, 5);
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[1].code, 'tagname-lowercase');
    });

    test('actionlint json template format', () => {
        const input = JSON.stringify([
            {
                message:
                    'shellcheck reported issue in this script: SC1009:info:1:1: The mentioned syntax error was in this simple command',
                filepath: 'workflow.yml',
                line: 7,
                column: 9,
                kind: 'shellcheck',
            },
            {
                message: 'unexpected EOF while lexing expression',
                filepath: 'workflow.yml',
                line: 8,
                column: 22,
                kind: 'expression',
            },
        ]);
        const diags = parseJsonOutput(input, 'actionlint');
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].message.includes('SC1009'), true);
        assert.strictEqual(diags[0].range.start.line, 6);
        assert.strictEqual(diags[1].range.start.character, 21);
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

    test('phpstan format with preamble text', () => {
        const input = [
            'Instructions for interpreting errors',
            '---------',
            '{"totals":{"errors":0,"file_errors":2},"files":{"/home/vix/Code/CRM/yii-application/src/backend/repositories/ChatBotsRepository.php":{"errors":2,"messages":[{"message":"Method backend\\\\repositories\\\\ChatBotsRepository::findByName() has invalid return type backend\\\\models\\\\ChatBots.","line":43,"ignorable":true,"identifier":"class.notFound"},{"message":"Call to static method findOne() on an unknown class backend\\\\models\\\\ChatBots.","line":45,"ignorable":true,"tip":"Learn more at https://phpstan.org/user-guide/discovering-symbols","identifier":"class.notFound"}]}},"errors":[]}',
        ].join('\n');
        const diags = parseJsonOutput(input, 'phpstan');
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(
            diags[0].message,
            'Method backend\\repositories\\ChatBotsRepository::findByName() has invalid return type backend\\models\\ChatBots.'
        );
        assert.strictEqual(diags[0].range.start.line, 42);
        assert.strictEqual(diags[0].code, 'class.notFound');
        assert.strictEqual(diags[1].range.start.line, 44);
        assert.strictEqual(diags[1].code, 'class.notFound');
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
                parser: 'missing-parser' as LinterConfig['parser'],
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
        const linter: LinterConfig = {
            name: 'markdownlint',
            filePatterns: ['*.md'],
            command: 'markdownlint',
            args: ['${file}'],
            parser: 'json',
            run: 'onOpen',
        };

        assert.strictEqual(shouldRunLinter(linter, 'onOpen'), true);
        assert.strictEqual(shouldRunLinter(linter, 'onSave'), true);
    });

    test('does not run onSave linters on open', () => {
        const linter: LinterConfig = {
            name: 'eslint',
            filePatterns: ['*.ts'],
            command: 'eslint',
            args: ['${file}'],
            parser: 'json',
            run: 'onSave',
        };

        assert.strictEqual(shouldRunLinter(linter, 'onOpen'), false);
        assert.strictEqual(shouldRunLinter(linter, 'onSave'), true);
    });

    test('does not run disabled linters', () => {
        const linter: LinterConfig = {
            name: 'eslint',
            filePatterns: ['*.ts'],
            command: 'eslint',
            args: ['${file}'],
            parser: 'json',
            run: 'onSave',
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

    test('collects runnable linters for matching targets', () => {
        const targets = resolveConfiguredTargets(
            [
                {
                    name: 'TypeScript',
                    filePatterns: ['*.ts'],
                    run: 'onSave',
                    linters: [
                        {
                            name: 'ESLint',
                            command: 'eslint',
                            args: ['${file}'],
                            parser: 'json',
                        },
                        {
                            name: 'manual only',
                            command: 'biome',
                            args: ['check', '${file}'],
                            parser: 'json',
                            run: 'manual',
                        },
                        {
                            name: 'disabled',
                            command: 'tsc',
                            args: ['--noEmit', '${file}'],
                            parser: 'parsable',
                            enabled: false,
                        },
                    ],
                },
            ],
            []
        );

        const manualLinters = collectRunnableLinters(targets, '/tmp/example.ts', 'manual');
        assert.deepStrictEqual(
            manualLinters.map((linter) => linter.label),
            ['ESLint', 'manual only']
        );
        assert.deepStrictEqual(
            manualLinters.map((linter) => linter.description),
            ['TypeScript', 'TypeScript']
        );

        const onSaveLinters = collectRunnableLinters(targets, '/tmp/example.ts', 'onSave');
        assert.deepStrictEqual(
            onSaveLinters.map((linter) => linter.label),
            ['ESLint']
        );
    });

    test('matches files with brace-expanded glob patterns', () => {
        const targets = resolveConfiguredTargets(
            [
                {
                    name: 'TypeScript',
                    filePatterns: ['*.{ts,tsx}'],
                    linters: [
                        {
                            name: 'ESLint',
                            command: 'eslint',
                            args: ['${file}'],
                            parser: 'json',
                        },
                    ],
                },
            ],
            []
        );

        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/example.ts', 'manual').length,
            1,
            '*.{ts,tsx} should match .ts files'
        );
        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/example.tsx', 'manual').length,
            1,
            '*.{ts,tsx} should match .tsx files'
        );
        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/example.js', 'manual').length,
            0,
            '*.{ts,tsx} should not match .js files'
        );
    });
    test('matches files with bracket expression glob patterns', () => {
        const targets = resolveConfiguredTargets(
            [
                {
                    name: 'Makefile',
                    filePatterns: ['[Mm]akefile'],
                    linters: [
                        {
                            name: 'checkmake',
                            command: 'checkmake',
                            args: ['${file}'],
                            parser: 'json',
                        },
                    ],
                },
            ],
            []
        );

        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/Makefile', 'manual').length,
            1,
            '[Mm]akefile should match Makefile'
        );
        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/makefile', 'manual').length,
            1,
            '[Mm]akefile should match makefile'
        );
        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/GNUMakefile', 'manual').length,
            0,
            '[Mm]akefile should not match GNUMakefile'
        );
    });

    test('matches files with negated bracket expression glob patterns', () => {
        const targets = resolveConfiguredTargets(
            [
                {
                    name: 'Non-JS',
                    filePatterns: ['*.[!j]s'],
                    linters: [
                        {
                            name: 'test',
                            command: 'test',
                            args: ['${file}'],
                            parser: 'json',
                        },
                    ],
                },
            ],
            []
        );

        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/example.ts', 'manual').length,
            1,
            '*.[!j]s should match .ts'
        );
        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/example.js', 'manual').length,
            0,
            '*.[!j]s should not match .js'
        );
    });

    test('treats unclosed [ as literal character', () => {
        const targets = resolveConfiguredTargets(
            [
                {
                    name: 'Literal Bracket',
                    filePatterns: ['[file.txt'],
                    linters: [
                        {
                            name: 'test',
                            command: 'test',
                            args: ['${file}'],
                            parser: 'json',
                        },
                    ],
                },
            ],
            []
        );

        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/[file.txt', 'manual').length,
            1,
            'unclosed [ should be treated as literal'
        );
        assert.strictEqual(
            collectRunnableLinters(targets, '/tmp/file.txt', 'manual').length,
            0,
            'unclosed [ should not be dropped silently'
        );
    });

    test('matchesIgnorePatterns returns false for empty patterns', () => {
        assert.strictEqual(matchesIgnorePatterns('/tmp/example.ts', []), false);
    });

    test('matchesIgnorePatterns matches file names', () => {
        assert.strictEqual(matchesIgnorePatterns('/tmp/vendor/lib.ts', ['vendor/**']), true);
        assert.strictEqual(matchesIgnorePatterns('/tmp/src/lib.ts', ['vendor/**']), false);
    });

    test('matchesIgnorePatterns matches extension patterns', () => {
        assert.strictEqual(matchesIgnorePatterns('/tmp/example.min.js', ['*.min.js']), true);
        assert.strictEqual(matchesIgnorePatterns('/tmp/example.ts', ['*.min.js']), false);
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

    test('parses multiline parse error output', () => {
        const stderr = [
            'File: lint-test/test.json',
            'Parse error on line 6, column 36:',
            '... 1, "value": "foo", },        { "id": 2...',
            '-----------------------^',
            'Trailing comma in object',
        ].join('\n');
        const diags = parseJsonlintOutput('', stderr, 'jsonlint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 5);
        assert.strictEqual(diags[0].range.start.character, 35);
        assert.strictEqual(diags[0].message, 'Trailing comma in object');
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

    test('parses dotenv-linter output with prologue and summary', () => {
        const input = [
            'Checking ../../../../tmp/test.env',
            '../../../../tmp/test.env:1 LowercaseKey: The app_name key should be in uppercase',
            '../../../../tmp/test.env:2 IncorrectDelimiter: The APP ENV key has incorrect delimiter',
            '',
            'Found 2 problems',
        ].join('\n');
        const diags = parseParsableOutput(input, 'dotenv-linter');
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].code, 'LowercaseKey');
        assert.strictEqual(diags[1].code, 'IncorrectDelimiter');
    });

    test('parses luacheck plain format', () => {
        const input = "/tmp/test.lua:1:7: (W211) unused variable 'foo'";
        const diags = parseParsableOutput(input, 'luacheck');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diags[0].code, 'W211');
        assert.strictEqual(diags[0].range.start.line, 0);
        assert.strictEqual(diags[0].range.start.character, 6);
    });

    test('parses nginx-lint errorformat output', () => {
        const input =
            'lint-test/test.yml:9:14: error[syntax/missing-semicolon]: Missing semicolon at end of directive';
        const diags = parseParsableOutput(input, 'nginx-lint');
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[0].code, 'syntax/missing-semicolon');
        assert.strictEqual(diags[0].message, 'Missing semicolon at end of directive');
    });

    test('info severity', () => {
        const input = 'file:1:1: [info] some note';
        const diags = parseParsableOutput(input, 'test');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Information);
    });

    test('parseLinterOutput parsable parser merges stdout and stderr', () => {
        const stdoutDiag = 'file.sh:2:1: [error] missing semicolon';
        const stderrDiag = 'file.sh:5:1: [warning] unreachable code';
        const diags = parseLinterOutput(
            {
                name: 'shellcheck',
                filePatterns: ['*.sh'],
                command: 'shellcheck',
                args: ['${file}'],
                parser: 'parsable',
                run: 'manual',
            },
            { code: 1, stdout: stdoutDiag, stderr: stderrDiag }
        );
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Warning);
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

    test('parses json output with preamble text', () => {
        const input = [
            'WARNING  Found incompatible custom yamllint configuration',
            'Failed: 2 failure(s), 0 warning(s) in 1 files processed of 1 encountered.',
            JSON.stringify([
                {
                    type: 'issue',
                    check_name: 'fqcn[action-core]',
                    description: 'Use FQCN for builtin module actions (debug).',
                    location: {
                        path: 'lint-test/ansible.yml',
                        positions: { begin: { line: 8, column: 7 } },
                    },
                    content: {
                        body: 'Use `ansible.builtin.debug` or `ansible.legacy.debug` instead.',
                    },
                },
                {
                    type: 'issue',
                    check_name: 'no-changed-when',
                    description: 'Commands should not change things if nothing needs doing.',
                    location: {
                        path: 'lint-test/ansible.yml',
                        lines: { begin: 10 },
                    },
                    content: { body: 'Task/Handler: shell echo done' },
                },
            ]),
        ].join('\n');

        const diags = parseAnsibleLintOutput(input, 'ansible-lint');
        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].range.start.line, 7);
        assert.strictEqual(diags[0].range.start.character, 6);
        assert.strictEqual(diags[0].code, 'fqcn[action-core]');
        assert.strictEqual(
            diags[0].message,
            'fqcn[action-core]: Use `ansible.builtin.debug` or `ansible.legacy.debug` instead.'
        );
        assert.strictEqual(diags[1].range.start.line, 9);
        assert.strictEqual(diags[1].code, 'no-changed-when');
    });
});

suite('Regex Parser', () => {
    const BASIC_PATTERN = String.raw`(?<line>\d+):(?<message>.+)`;
    const FULL_PATTERN =
        String.raw`(?<line>\d+):(?<col>\d+):\s*(?<severity>\w+):\s*(?<message>.+?)\s*\[(?<code>[\w-]+)\]`;

    test('empty input returns no diagnostics', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: BASIC_PATTERN },
                run: 'manual',
            },
            { code: 0, stdout: '', stderr: '' }
        );
        assert.strictEqual(diags.length, 0);
    });

    test('basic match: line and message', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: BASIC_PATTERN },
                run: 'manual',
            },
            { code: 1, stdout: '3:Something went wrong', stderr: '' }
        );
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 2);
        assert.strictEqual(diags[0].message, 'Something went wrong');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diags[0].source, 'test');
    });

    test('with column: sets explicit character position', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: String.raw`(?<line>\d+):(?<col>\d+):(?<message>.+)` },
                run: 'manual',
            },
            { code: 1, stdout: '5:10:Some issue', stderr: '' }
        );
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 4);
        assert.strictEqual(diags[0].range.start.character, 9);
    });

    test('severity mapping: error', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: {
                    pattern: String.raw`(?<line>\d+):(?<severity>\w+):(?<message>.+)`,
                    flags: 'g',
                },
                run: 'manual',
            },
            { code: 1, stdout: '1:error:Bad thing', stderr: '' }
        );
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('severity mapping: info/information', () => {
        const pattern = String.raw`(?<line>\d+):(?<severity>\w+):(?<message>.+)`;
        const mkLinter = (sev: string) =>
            parseLinterOutput(
                {
                    name: 'test',
                    filePatterns: ['*'],
                    command: 'test',
                    args: [],
                    parser: { pattern },
                    run: 'manual',
                },
                { code: 0, stdout: `1:${sev}:Hint`, stderr: '' }
            );

        assert.strictEqual(mkLinter('info')[0].severity, vscode.DiagnosticSeverity.Information);
        assert.strictEqual(
            mkLinter('information')[0].severity,
            vscode.DiagnosticSeverity.Information
        );
    });

    test('severity mapping: aliases used by CLI formatters', () => {
        const pattern = String.raw`(?<line>\d+):(?<severity>\w+):(?<message>.+)`;
        const cases: Array<[string, vscode.DiagnosticSeverity]> = [
            ['fatal', vscode.DiagnosticSeverity.Error],
            ['err', vscode.DiagnosticSeverity.Error],
            ['warn', vscode.DiagnosticSeverity.Warning],
            ['notice', vscode.DiagnosticSeverity.Warning],
            ['note', vscode.DiagnosticSeverity.Information],
            ['style', vscode.DiagnosticSeverity.Information],
            ['hint', vscode.DiagnosticSeverity.Information],
        ];

        for (const [severity, expected] of cases) {
            const diags = parseRegexFixture('test', { pattern }, `1:${severity}:Message`);
            assert.strictEqual(diags[0].severity, expected);
        }
    });

    test('defaultSeverity is used when severity group is missing', () => {
        const diags = parseRegexFixture(
            'test',
            { pattern: BASIC_PATTERN, defaultSeverity: 'error' },
            '1:Missing severity'
        );

        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('severity mapping: unknown defaults to warning', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: String.raw`(?<line>\d+):(?<severity>\w+):(?<message>.+)` },
                run: 'manual',
            },
            { code: 1, stdout: '1:notice:Something', stderr: '' }
        );
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
    });

    test('code group sets diagnostic code', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: {
                    pattern: FULL_PATTERN,
                    flags: 'g',
                },
                run: 'manual',
            },
            { code: 1, stdout: '3:7: error: Unused import [no-unused-imports]', stderr: '' }
        );
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].code, 'no-unused-imports');
        assert.strictEqual(diags[0].message, 'Unused import');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('multiple matches returns one diagnostic per match', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: BASIC_PATTERN, flags: 'gm' },
                run: 'manual',
            },
            { code: 1, stdout: '1:First error\n2:Second error\n3:Third error', stderr: '' }
        );
        assert.strictEqual(diags.length, 3);
        assert.strictEqual(diags[0].range.start.line, 0);
        assert.strictEqual(diags[1].range.start.line, 1);
        assert.strictEqual(diags[2].range.start.line, 2);
    });

    test('unmatched lines are silently skipped', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: BASIC_PATTERN, flags: 'gm' },
                run: 'manual',
            },
            {
                code: 1,
                stdout: 'This line does not match\n5:This line matches\nAnother non-match',
                stderr: '',
            }
        );
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 4);
    });

    test('invalid regex returns no diagnostics', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: '(?<line>\\d+' }, // unclosed group
                run: 'manual',
            },
            { code: 1, stdout: '1:message', stderr: '' }
        );
        assert.strictEqual(diags.length, 0);
    });

    test('match missing required message group is skipped', () => {
        // Pattern has line but no message group
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: String.raw`(?<line>\d+):\w+` },
                run: 'manual',
            },
            { code: 1, stdout: '5:error', stderr: '' }
        );
        assert.strictEqual(diags.length, 0);
    });

    test('output:stdout parses only stdout', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: BASIC_PATTERN, output: 'stdout' },
                run: 'manual',
            },
            { code: 1, stdout: '1:From stdout', stderr: '2:From stderr' }
        );
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'From stdout');
    });

    test('output:stderr parses only stderr', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: BASIC_PATTERN, output: 'stderr' },
                run: 'manual',
            },
            { code: 1, stdout: '1:From stdout', stderr: '2:From stderr' }
        );
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].message, 'From stderr');
    });

    test('output:both (default) parses stdout and stderr', () => {
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: BASIC_PATTERN, output: 'both' },
                run: 'manual',
            },
            { code: 1, stdout: '1:From stdout', stderr: '2:From stderr' }
        );
        assert.strictEqual(diags.length, 2);
    });

    test('g flag is added automatically when absent', () => {
        // Without 'g' flag exec would only return first match; with auto-added 'g' all matches found
        const diags = parseLinterOutput(
            {
                name: 'test',
                filePatterns: ['*'],
                command: 'test',
                args: [],
                parser: { pattern: BASIC_PATTERN, flags: 'm' }, // no g, multiline
                run: 'manual',
            },
            { code: 1, stdout: '1:First\n2:Second', stderr: '' }
        );
        assert.strictEqual(diags.length, 2);
    });

    test('zero-width matches do not hang parser', () => {
        const diags = parseRegexFixture(
            'test',
            { pattern: String.raw`(?=(?<line>\d):(?<message>\w+))`, flags: 'gm' },
            '1:First\n2:Second'
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].message, 'First');
        assert.strictEqual(diags[1].message, 'Second');
    });
});

suite('Regex Utility Parser Configs', () => {
    test('shellcheck gcc format', () => {
        const output = [
            'lint-test/test.sh:7:16: note: Double quote to prevent globbing and word splitting. [SC2086]',
            'lint-test/test.sh:7:16: note: Prefer putting braces around variable references even when not strictly required. [SC2250]',
        ].join('\n');
        const diags = parseRegexFixture(
            'Shell Check',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<severity>\w+): (?<message>.+?) \[(?<code>SC\d+)\]$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].range.start.line, 6);
        assert.strictEqual(diags[0].range.start.character, 15);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Information);
        assert.strictEqual(diags[0].code, 'SC2086');
    });

    test('hadolint tty format', () => {
        const output = [
            'lint-test/Dockerfile:4 DL3007 warning: Using latest is prone to errors if the image will ever update. Pin the version explicitly to a release tag',
            'lint-test/Dockerfile:12 DL3025 error: Use arguments JSON notation for CMD and ENTRYPOINT arguments',
        ].join('\n');
        const diags = parseRegexFixture(
            'HadoLint',
            {
                pattern: String.raw`^.+?:(?<line>\d+) (?<code>\S+) (?<severity>\w+): (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[1].range.start.line, 11);
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[1].code, 'DL3025');
    });

    test('markdownlint default format', () => {
        const output =
            'lint-test/test.md:9:1 error MD029/ol-prefix Ordered list item prefix [Expected: 3; Actual: 1; Style: 1/2/3]';
        const diags = parseRegexFixture(
            'Markdown Lint',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+) (?<severity>\w+) (?<code>[A-Z0-9]+)(?:/\S+)? (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].code, 'MD029');
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('yamllint parsable format', () => {
        const output = 'lint-test/test.yml:1:1: [warning] missing document start "---" (document-start)';
        const diags = parseRegexFixture(
            'YAML Lint',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): \[(?<severity>\w+)\] (?<message>.+?) \((?<code>[^)]+)\)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].code, 'document-start');
        assert.strictEqual(diags[0].message, 'missing document start "---"');
    });

    test('ansible-lint full format', () => {
        const output = [
            'fqcn[action-core]: Use FQCN for builtin module actions (debug).',
            'lint-test/ansible.yml:8:7 Use `ansible.builtin.debug` or `ansible.legacy.debug` instead.',
            '',
            'no-changed-when: Commands should not change things if nothing needs doing.',
            'lint-test/ansible.yml:10 Task/Handler: shell echo done',
        ].join('\n');
        const diags = parseRegexFixture(
            'Ansible Lint',
            {
                pattern: String.raw`^(?<code>[a-z][\w.\[\]-]+): (?<message>.+)\n.+?:(?<line>\d+)(?::(?<col>\d+))?`,
                flags: 'gm',
                defaultSeverity: 'warning',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].range.start.line, 7);
        assert.strictEqual(diags[0].range.start.character, 6);
        assert.strictEqual(diags[0].code, 'fqcn[action-core]');
        assert.strictEqual(diags[1].range.start.line, 9);
        assert.strictEqual(diags[1].code, 'no-changed-when');
    });

    test('ruff github format', () => {
        const output =
            '::error title=ruff (F841),file=/home/vix/Code/lint-runner/lint-test/test.py,line=2,col=5,endLine=2,endColumn=6::lint-test/test.py:2:5: F841 Local variable `x` is assigned to but never used%0A  help: Remove assignment to unused variable `x`';
        const diags = parseRegexFixture(
            'Ruff',
            {
                pattern: String.raw`^::(?<severity>error|warning) title=ruff \((?<code>[^)]+)\),file=[^,]+,line=(?<line>\d+),col=(?<col>\d+),endLine=\d+,endColumn=\d+::(?:[^:]+:\d+:\d+: [A-Z]\d+ )?(?<message>[^\n%]+)`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.character, 4);
        assert.strictEqual(diags[0].code, 'F841');
        assert.strictEqual(diags[0].message, 'Local variable `x` is assigned to but never used');
    });

    test('dotenv-linter plain format', () => {
        const output = [
            'Checking lint-test/.env',
            'lint-test/.env:1 LowercaseKey: The app_name key should be in uppercase',
            'lint-test/.env:2 IncorrectDelimiter: The APP ENV key has incorrect delimiter',
            '',
            'Found 2 problems',
        ].join('\n');
        const diags = parseRegexFixture(
            'Dotenv Linter',
            {
                pattern: String.raw`^.+?:(?<line>\d+) (?<code>[A-Za-z][\w-]*): (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].code, 'LowercaseKey');
        assert.strictEqual(diags[1].range.start.line, 1);
    });

    test('luacheck plain format', () => {
        const output = [
            "/tmp/lint-runner-test.lua:1:7: (W211) unused variable 'unused'",
            "/tmp/lint-runner-test.lua:2:7: (W113) accessing undefined variable 'unknown'",
        ].join('\n');
        const diags = parseRegexFixture(
            'LuaCheck',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): \((?<code>[A-Z]\d+)\) (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].code, 'W211');
        assert.strictEqual(diags[1].range.start.character, 6);
    });

    test('taplo syntax format', () => {
        const output = [
            'error: invalid TOML',
            '  ┌─ /tmp/test.toml:1:5',
            '  │',
            '1 │ x = ]',
            '  │     ^ expected value',
        ].join('\n');
        const diags = parseRegexFixture(
            'Taplo',
            {
                pattern: String.raw`(?<severity>error|warning|info):\s*(?<message>[^\n]+)[\s\S]*?\u250c\u2500\s+[^:\n]+:(?<line>\d+):(?<col>\d+)`,
            },
            output
        );

        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 0);
        assert.strictEqual(diags[0].range.start.character, 4);
        assert.strictEqual(diags[0].message, 'invalid TOML');
    });

    test('eslint stylish format', () => {
        const output = [
            '/home/vix/Code/lint-runner/lint-test/test.js',
            "  2:7  error    'unused' is assigned a value but never used  no-unused-vars",
            '  8:1  warning  Unexpected console statement                 no-console',
        ].join('\n');
        const diags = parseRegexFixture(
            'ESLint',
            {
                pattern: String.raw`^\s*(?<line>\d+):(?<col>\d+)\s+(?<severity>error|warning)\s+(?<message>.+?)\s{2,}(?<code>\S+)\s*$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diags[1].code, 'no-console');
    });

    test('stylelint compact format', () => {
        const output =
            '/home/vix/Code/lint-runner/lint-test/test.css: line 6, col 12, error - Disallowed named color "red" (color-named)';
        const diags = parseRegexFixture(
            'Style Lint',
            {
                pattern: String.raw`^.+?: line (?<line>\d+), col (?<col>\d+), (?<severity>\w+) - (?<message>.+?) \((?<code>[^)]+)\)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 5);
        assert.strictEqual(diags[0].code, 'color-named');
    });

    test('linthtml no-color format', () => {
        const output = [
            ' 2:1  error  <HTML> tag should specify the language of the page using the "lang" attribute  html-req-lang      ',
            ' 8:9  error  Invalid case for tag <h1>, tag names must be written in lowercase              tag-name-lowercase ',
        ].join('\n');
        const diags = parseRegexFixture(
            'Lint HTML',
            {
                pattern: String.raw`^\s*(?<line>\d+):(?<col>\d+)\s+(?<severity>error|warning)\s+(?<message>.+?)\s{2,}(?<code>\S+)\s*$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].code, 'html-req-lang');
        assert.strictEqual(diags[1].range.start.character, 8);
    });

    test('htmlhint unix format', () => {
        const output = [
            '/home/vix/Code/lint-runner/lint-test/test.html:2:6: An lang attribute must be present on <html> elements. [warning/html-lang-require]',
            '/home/vix/Code/lint-runner/lint-test/test.html:8:9: The html element name of [ H1 ] must be in lowercase. [error/tagname-lowercase]',
        ].join('\n');
        const diags = parseRegexFixture(
            'HTML Hint',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<message>.+) \[(?<severity>[^/\]]+)/(?<code>[^\]]+)\]$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[1].code, 'tagname-lowercase');
    });

    test('sqlfluff github annotation native format', () => {
        const output = [
            '::warning title=SQLFluff,file=lint-test/test.sql,line=1,col=1,endLine=1,endColumn=7::CP01: Keywords must be upper case. [capitalisation.keywords]',
            "::warning title=SQLFluff,file=lint-test/test.sql,line=1,col=35,endLine=1,endColumn=40::LT14: The 'where' keyword should always start a new line. [layout.keyword_newline]",
        ].join('\n');
        const diags = parseRegexFixture(
            'Sql Fluff',
            {
                pattern: String.raw`^::(?<severity>error|warning|notice) title=SQLFluff,file=[^,]+,line=(?<line>\d+),col=(?<col>\d+),endLine=\d+,endColumn=\d+::(?<code>[A-Z]+\d+): (?<message>.+?)(?: \[[^\]]+\])?$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].code, 'CP01');
        assert.strictEqual(diags[1].range.start.character, 34);
    });

    test('checkmake json format with regex', () => {
        const output = JSON.stringify(
            [
                {
                    rule: 'phonydeclared',
                    violation: 'Target "all" should be declared PHONY.',
                    file_name: 'lint-test/Makefile',
                    line_number: 10,
                },
                {
                    rule: 'minphony',
                    violation: 'Required target "clean" must be declared PHONY.',
                    file_name: 'lint-test/Makefile',
                    line_number: 10,
                },
            ],
            null,
            2
        );
        const diags = parseRegexFixture(
            'Check Make',
            {
                pattern: String.raw`\{\s*"rule":\s*"(?<code>[^"]+)",\s*"violation":\s*"(?<message>(?:\\.|[^"])*)",\s*"file_name":\s*"[^"]+",\s*"line_number":\s*(?<line>\d+)\s*\}`,
                messageFormat: 'json',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].code, 'phonydeclared');
        assert.strictEqual(diags[1].message, 'Required target "clean" must be declared PHONY.');
    });

    test('nginx-lint errorformat', () => {
        const output = [
            "/tmp/lint-runner-nginx.conf:1:1: error[syntax/invalid-directive-context]: 'server' directive must be inside one of: http, stream, mail, not in main context",
            '/tmp/lint-runner-nginx.conf:2:13: error[syntax/missing-semicolon]: Missing semicolon at end of directive',
        ].join('\n');
        const diags = parseRegexFixture(
            'Nginx Lint',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<severity>\w+)\[(?<code>[^\]]+)\]: (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[0].code, 'syntax/invalid-directive-context');
    });

    test('xmllint stderr format', () => {
        const stderr = [
            'lint-test/test.xml:6: parser error : Opening and ending tag mismatch: value line 5 and item',
            '    </item>',
            '           ^',
        ].join('\n');
        const diags = parseRegexFixture(
            'XML Lint',
            {
                pattern: String.raw`^.+?:(?<line>\d+): (?:(?:parser )?(?<severity>error|warning)) : (?<message>.+)$`,
                flags: 'gm',
                output: 'stderr',
            },
            '',
            stderr
        );

        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.line, 5);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('jsonlint single-line format', () => {
        const output = 'lint-test/test.json: line 4, col 11, Duplicate key: "name".';
        const diags = parseRegexFixture(
            'JSON Lint',
            {
                pattern: String.raw`^(?:.+?:\s*)?line\s+(?<line>\d+),\s*col\s+(?<col>\d+),\s*(?<message>.+?)(?:\.)?$`,
                flags: 'gm',
                defaultSeverity: 'error',
            },
            output
        );

        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].range.start.character, 10);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[0].message, 'Duplicate key: "name"');
    });

    test('actionlint default format', () => {
        const output = [
            'lint-test/.github/workflows/test.yml:14:9: step must run script with "run" section or run action with "uses" section [syntax-check]',
            "lint-test/.github/workflows/test.yml:15:29: got unexpected character ' ' while lexing == operator, expecting '=' [expression]",
        ].join('\n');
        const diags = parseRegexFixture(
            'Action Lint',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<message>.+?) \[(?<code>[^\]]+)\]$`,
                flags: 'gm',
                defaultSeverity: 'error',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].code, 'syntax-check');
        assert.strictEqual(diags[1].range.start.character, 28);
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Error);
    });

    test('phpcs emacs format', () => {
        const output = [
            '/home/vix/Code/lint-runner/lint-test/test.php:1:1: warning - A file should declare new symbols and cause no other side effects.',
            '/home/vix/Code/lint-runner/lint-test/test.php:1:1: error - Missing declare(strict_types=1).',
        ].join('\n');
        const diags = parseRegexFixture(
            'PHP CodeSniffer',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<severity>warning|error) - (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diags[1].severity, vscode.DiagnosticSeverity.Error);
    });

    test('phpmd text format', () => {
        const output = [
            "/home/vix/Code/lint-runner/lint-test/test.php:5  UnusedLocalVariable  Avoid unused local variables such as '$unused'.",
            "/home/vix/Code/lint-runner/lint-test/test.php:6  UnusedLocalVariable  Avoid unused local variables such as '$magic'.",
        ].join('\n');
        const diags = parseRegexFixture(
            'PHP Mess Detector',
            {
                pattern: String.raw`^.+?:(?<line>\d+)\s+(?<code>\S+)\s+(?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].range.start.line, 4);
        assert.strictEqual(diags[0].code, 'UnusedLocalVariable');
    });

    test('phpstan raw format', () => {
        const output = [
            'Instructions for interpreting errors',
            '---------',
            '/home/vix/Code/lint-runner/lint-test/test.php:3:Function greet() has no return type specified. [identifier=missingType.return]',
            '/home/vix/Code/lint-runner/lint-test/test.php:10:Parameter #1 (mixed) of echo cannot be converted to string. [identifier=echo.nonString]',
        ].join('\n');
        const diags = parseRegexFixture(
            'PHPStan',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<message>.+?)(?: \[identifier=(?<code>[^\]]+)\])?$`,
                flags: 'gm',
                defaultSeverity: 'error',
            },
            output
        );

        assert.strictEqual(diags.length, 2);
        assert.strictEqual(diags[0].range.start.line, 2);
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diags[0].code, 'missingType.return');
    });
});
