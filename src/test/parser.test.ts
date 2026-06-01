import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    applyCommandTemplate,
    buildCommandEnv,
    collectRunnablePipelines,
    matchesIgnorePatterns,
    mergeToolConfiguration,
    normalizeDiagnosticRanges,
    parseToolOutput,
    resolveToolConfiguration,
    shouldProcessToolFile,
    validateToolConfigScopes,
    type RegexParserConfig,
    type ToolConfigurationPatch,
} from '../toolRunner.js';

const TEST_REGEX_PARSER: RegexParserConfig = {
    pattern: String.raw`(?<line>\d+):(?<col>\d+):(?<severity>\w+):(?<message>.+)`,
};

function parseRegexFixture(
    name: string,
    parser: RegexParserConfig,
    stdout: string,
    stderr = ''
): vscode.Diagnostic[] {
    return parseToolOutput(
        name,
        {
            kind: 'diagnostic',
            command: 'test',
            args: [],
            parser,
        },
        { code: 1, stdout, stderr }
    );
}

suite('Tool Runner', () => {
    test('expands built-in and custom command variables', () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const filePath = path.join(workspaceRoot, 'src', 'example.test.ts');
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath ?? '';
        const result = applyCommandTemplate(
            '${bin}|${fileBasename}|${fileBasenameNoExtension}|${unknown}',
            filePath,
            { bin: '${workspaceFolder}/vendor/bin' }
        );

        assert.strictEqual(result, `${workspaceFolder}/vendor/bin|example.test.ts|example.test|${'${unknown}'}`);
    });

    test('prepends shell PATH to command PATH', () => {
        const env = buildCommandEnv('/tmp/lint-runner-bin');
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
        assert.strictEqual(env[pathKey]?.split(path.delimiter)[0], '/tmp/lint-runner-bin');
    });

    test('moves diagnostics without explicit column to first non-whitespace word', async () => {
        const filePath = path.resolve(__dirname, '../../lint-test/test.php');
        const diagnostics = parseRegexFixture(
            'dotenv',
            {
                pattern: String.raw`^.+?:(?<line>\d+) (?<code>[A-Za-z][\w-]*): (?<message>.+)$`,
                flags: 'gm',
            },
            'lint-test/test.php:5 LowercaseKey: The key should be uppercase',
        );

        await normalizeDiagnosticRanges(filePath, diagnostics);

        assert.strictEqual(diagnostics[0].range.start.line, 4);
        assert.strictEqual(diagnostics[0].range.start.character, 4);
        assert.strictEqual(diagnostics[0].range.end.character, 11);
    });

    test('extends diagnostics with explicit column to first whitespace', async () => {
        const filePath = path.resolve(__dirname, '../../lint-test/test.js');
        const diagnostics = parseRegexFixture('eslint', TEST_REGEX_PARSER, '2:7:error:Unused variable');

        await normalizeDiagnosticRanges(filePath, diagnostics);

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 1);
        assert.strictEqual(diagnostics[0].range.start.character, 6);
        assert.strictEqual(diagnostics[0].range.end.character, 12);
    });

    test('preserves explicit end range during normalization', async () => {
        const filePath = path.resolve(__dirname, '../../lint-test/test.js');
        const diagnostics = parseRegexFixture(
            'ruff',
            {
                pattern: String.raw`(?<line>\d+):(?<col>\d+):(?<endLine>\d+):(?<endCol>\d+):(?<message>.+)`,
            },
            '4:10:4:15:Function name'
        );

        await normalizeDiagnosticRanges(filePath, diagnostics);

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 3);
        assert.strictEqual(diagnostics[0].range.start.character, 9);
        assert.strictEqual(diagnostics[0].range.end.line, 3);
        assert.strictEqual(diagnostics[0].range.end.character, 14);
    });

    test('parses diagnostic tool output', () => {
        const diagnostics = parseToolOutput(
            'eslint',
            {
                kind: 'diagnostic',
                command: 'eslint',
                args: ['${file}'],
                parser: TEST_REGEX_PARSER,
            },
            { code: 1, stdout: '2:7:error:Unused variable', stderr: '' }
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].source, 'eslint');
        assert.strictEqual(diagnostics[0].range.start.line, 1);
        assert.strictEqual(diagnostics[0].range.start.character, 6);
    });

    test('matches ignore patterns by file name and path', () => {
        assert.strictEqual(matchesIgnorePatterns('/repo/src/app.min.js', ['*.min.js']), true);
        assert.strictEqual(matchesIgnorePatterns('/repo/vendor/package/file.php', ['vendor/**']), true);
        assert.strictEqual(matchesIgnorePatterns('/repo/src/app.js', ['*.min.js']), false);
    });

    test('matches files with brace-expanded glob patterns', () => {
        assert.strictEqual(matchesIgnorePatterns('/tmp/example.ts', ['*.{ts,tsx}']), true);
        assert.strictEqual(matchesIgnorePatterns('/tmp/example.tsx', ['*.{ts,tsx}']), true);
        assert.strictEqual(matchesIgnorePatterns('/tmp/example.js', ['*.{ts,tsx}']), false);
    });

    test('matches files with bracket expression glob patterns', () => {
        assert.strictEqual(matchesIgnorePatterns('/tmp/Makefile', ['[Mm]akefile']), true);
        assert.strictEqual(matchesIgnorePatterns('/tmp/makefile', ['[Mm]akefile']), true);
        assert.strictEqual(matchesIgnorePatterns('/tmp/GNUMakefile', ['[Mm]akefile']), false);
    });

    test('matches files with negated bracket expression glob patterns', () => {
        assert.strictEqual(matchesIgnorePatterns('/tmp/example.ts', ['*.[!j]s']), true);
        assert.strictEqual(matchesIgnorePatterns('/tmp/example.js', ['*.[!j]s']), false);
    });

    test('treats unclosed [ as literal character', () => {
        assert.strictEqual(matchesIgnorePatterns('/tmp/[file.txt', ['[file.txt']), true);
        assert.strictEqual(matchesIgnorePatterns('/tmp/file.txt', ['[file.txt']), false);
    });

    test('enforces max file size inclusively', () => {
        assert.strictEqual(shouldProcessToolFile(100, undefined), true);
        assert.strictEqual(shouldProcessToolFile(100, 100), true);
        assert.strictEqual(shouldProcessToolFile(101, 100), false);
    });
});

suite('Tool configuration', () => {
    test('merges vars tools and targets by key or name across scopes', () => {
        const base: ToolConfigurationPatch = {
            vars: { composerBin: '${workspaceFolder}/vendor/bin', phpBin: '/usr/bin' },
            tools: {
                phpstan: {
                    kind: 'diagnostic',
                    command: '${composerBin}/phpstan',
                    args: ['analyse', '${file}'],
                    parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                },
            },
            targets: [
                {
                    name: 'PHP',
                    match: { languages: ['php'], files: ['**/*.php'] },
                    manual: { strategy: 'sequence', tools: ['phpstan'] },
                },
            ],
        };

        const result = mergeToolConfiguration(base, {
            vars: { phpBin: '/opt/php/bin' },
            tools: {
                phpstan: {
                    args: ['analyse', '--memory-limit=1G', '${file}'],
                    successExitCodes: [0, 1],
                },
            },
            targets: [
                {
                    name: 'PHP',
                    onSave: { strategy: 'parallel', tools: ['phpstan'] },
                },
            ],
        });

        assert.strictEqual(result.vars?.phpBin, '/opt/php/bin');
        assert.deepStrictEqual(result.tools?.phpstan?.args, ['analyse', '--memory-limit=1G', '${file}']);
        assert.deepStrictEqual(result.targets?.[0].manual, { strategy: 'sequence', tools: ['phpstan'] });
        assert.deepStrictEqual(result.targets?.[0].onSave, { strategy: 'parallel', tools: ['phpstan'] });
    });

    test('validates tool config and rejects unsupported target keys and array pipeline shorthand', () => {
        const issues = validateToolConfigScopes(
            [
                {
                    label: 'Workspace settings',
                    config: {
                        vars: { a: '${b}', b: '${a}' },
                        tools: {
                            eslint: { kind: 'diagnostic', command: 'eslint', args: ['${file}'] },
                            prettier: {
                                kind: 'write',
                                command: 'prettier',
                                args: ['--write', '${file}'],
                                parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                            },
                        },
                        targets: [
                            {
                                name: 'JS',
                                languages: ['javascript'],
                                [`lin${'ters'}`]: [],
                                match: { languages: ['javascript'], files: ['**/*.js'] },
                                manual: ['prettier', 'missing-tool'] as unknown as never,
                            },
                        ],
                    },
                },
            ],
            { knownLanguageIds: ['javascript'], env: { PATH: process.env.PATH ?? '' } }
        );

        assert.match(issues.errors.join('\n'), /var 'a' contains a circular reference/);
        assert.match(issues.errors.join('\n'), /tool 'eslint' parser is missing pattern/);
        assert.match(issues.errors.join('\n'), /tool 'prettier' with kind 'write' must not define parser/);
        assert.match(issues.errors.join('\n'), new RegExp(`target 'JS' contains unsupported key 'lin${'ters'}'`));
        assert.match(issues.errors.join('\n'), /target 'JS' pipeline 'manual' must be an object/);
    });

    test('collects runnable pipelines using target match languages files and exclude', async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const phpFilePath = path.join(workspaceRoot, 'lint-test', 'test.php');
        const vendorFilePath = path.join(workspaceRoot, 'lint-test', 'vendor', 'Package.php');
        const jsFilePath = path.join(workspaceRoot, 'lint-test', 'test.js');
        await vscode.workspace.openTextDocument(vscode.Uri.file(phpFilePath));
        await vscode.workspace.openTextDocument(vscode.Uri.file(jsFilePath));

        const config = resolveToolConfiguration({
            tools: {
                phpstan: {
                    kind: 'diagnostic',
                    command: 'phpstan',
                    args: ['analyse', '${file}'],
                    parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                },
            },
            targets: [
                {
                    name: 'PHP',
                    match: { languages: ['php'], files: ['**/*.php'], exclude: ['**/vendor/**'] },
                    manual: { strategy: 'sequence', tools: ['phpstan'] },
                },
            ],
        });

        assert.strictEqual(collectRunnablePipelines(config, phpFilePath, 'manual').length, 1);
        assert.strictEqual(collectRunnablePipelines(config, vendorFilePath, 'manual').length, 0);
        assert.strictEqual(collectRunnablePipelines(config, jsFilePath, 'manual').length, 0);
    });

    test('collects both onSave and onOpen pipelines for save trigger', async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const jsFilePath = path.join(workspaceRoot, 'lint-test', 'test.js');
        await vscode.workspace.openTextDocument(vscode.Uri.file(jsFilePath));

        const config = resolveToolConfiguration({
            tools: {
                eslint: {
                    kind: 'diagnostic',
                    command: 'eslint',
                    args: ['${file}'],
                    parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                },
                prettier: {
                    kind: 'write',
                    command: 'prettier',
                    args: ['--write', '${file}'],
                },
            },
            targets: [
                {
                    name: 'JS',
                    match: { languages: ['javascript'] },
                    onOpen: { strategy: 'sequence', tools: ['eslint'] },
                    onSave: { strategy: 'sequence', tools: ['prettier'] },
                },
            ],
        });

        assert.deepStrictEqual(
            collectRunnablePipelines(config, jsFilePath, 'onSave').map((pipeline) => pipeline.pipelineName),
            ['onSave', 'onOpen']
        );
    });
});

suite('Regex Parser', () => {
    const BASIC_PATTERN = String.raw`(?<line>\d+):(?<message>.+)`;
    const FULL_PATTERN =
        String.raw`(?<line>\d+):(?<col>\d+):\s*(?<severity>\w+):\s*(?<message>.+?)\s*\[(?<code>[\w-]+)\]`;

    test('empty input returns no diagnostics', () => {
        const diagnostics = parseRegexFixture('test', { pattern: BASIC_PATTERN }, '');

        assert.strictEqual(diagnostics.length, 0);
    });

    test('basic match: line and message', () => {
        const diagnostics = parseRegexFixture('test', { pattern: BASIC_PATTERN }, '3:Something went wrong');

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 2);
        assert.strictEqual(diagnostics[0].message, 'Something went wrong');
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diagnostics[0].source, 'test');
    });

    test('with column: sets explicit character position', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: String.raw`(?<line>\d+):(?<col>\d+):(?<message>.+)` },
            '5:10:Some issue'
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 4);
        assert.strictEqual(diagnostics[0].range.start.character, 9);
    });

    test('with endLine and endCol: sets explicit range', () => {
        const diagnostics = parseRegexFixture(
            'test',
            {
                pattern: String.raw`(?<line>\d+):(?<col>\d+):(?<endLine>\d+):(?<endCol>\d+):(?<message>.+)`,
            },
            '2:5:3:2:Some issue'
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 1);
        assert.strictEqual(diagnostics[0].range.start.character, 4);
        assert.strictEqual(diagnostics[0].range.end.line, 2);
        assert.strictEqual(diagnostics[0].range.end.character, 1);
    });

    test('severity mapping: error', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: String.raw`(?<line>\d+):(?<severity>\w+):(?<message>.+)`, flags: 'g' },
            '1:error:Bad thing'
        );

        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('severity mapping: info/information', () => {
        const pattern = String.raw`(?<line>\d+):(?<severity>\w+):(?<message>.+)`;
        const parseSeverity = (severity: string) => parseRegexFixture('test', { pattern }, `1:${severity}:Hint`);

        assert.strictEqual(parseSeverity('info')[0].severity, vscode.DiagnosticSeverity.Information);
        assert.strictEqual(parseSeverity('information')[0].severity, vscode.DiagnosticSeverity.Information);
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
            const diagnostics = parseRegexFixture('test', { pattern }, `1:${severity}:Message`);
            assert.strictEqual(diagnostics[0].severity, expected);
        }
    });

    test('defaultSeverity is used when severity group is missing', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: BASIC_PATTERN, defaultSeverity: 'error' },
            '1:Missing severity'
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('severity mapping: unknown defaults to warning', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: String.raw`(?<line>\d+):(?<severity>\w+):(?<message>.+)` },
            '1:unknown:Something'
        );

        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
    });

    test('code group sets diagnostic code', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: FULL_PATTERN, flags: 'g' },
            '3:7: error: Unused import [no-unused-imports]'
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].code, 'no-unused-imports');
        assert.strictEqual(diagnostics[0].message, 'Unused import');
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('multiple matches returns one diagnostic per match', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: BASIC_PATTERN, flags: 'gm' },
            '1:First error\n2:Second error\n3:Third error'
        );

        assert.strictEqual(diagnostics.length, 3);
        assert.strictEqual(diagnostics[0].range.start.line, 0);
        assert.strictEqual(diagnostics[1].range.start.line, 1);
        assert.strictEqual(diagnostics[2].range.start.line, 2);
    });

    test('unmatched lines are silently skipped', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: BASIC_PATTERN, flags: 'gm' },
            'This line does not match\n5:This line matches\nAnother non-match'
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 4);
    });

    test('invalid regex returns no diagnostics', () => {
        const diagnostics = parseRegexFixture('test', { pattern: '(?<line>\\d+' }, '1:message');

        assert.strictEqual(diagnostics.length, 0);
    });

    test('match missing required message group is skipped', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: String.raw`(?<line>\d+):\w+` },
            '5:error'
        );

        assert.strictEqual(diagnostics.length, 0);
    });

    test('output:stdout parses only stdout', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: BASIC_PATTERN, output: 'stdout' },
            '1:From stdout',
            '2:From stderr'
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].message, 'From stdout');
    });

    test('output:stderr parses only stderr', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: BASIC_PATTERN, output: 'stderr' },
            '1:From stdout',
            '2:From stderr'
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].message, 'From stderr');
    });

    test('output:both (default) parses stdout and stderr', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: BASIC_PATTERN, output: 'both' },
            '1:From stdout',
            '2:From stderr'
        );

        assert.strictEqual(diagnostics.length, 2);
    });

    test('g flag is added automatically when absent', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: BASIC_PATTERN, flags: 'm' },
            '1:First\n2:Second'
        );

        assert.strictEqual(diagnostics.length, 2);
    });

    test('zero-width matches do not hang parser', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: String.raw`(?=(?<line>\d):(?<message>\w+))`, flags: 'gm' },
            '1:First\n2:Second'
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].message, 'First');
        assert.strictEqual(diagnostics[1].message, 'Second');
    });

    test('malformed numeric captures are skipped without throwing', () => {
        const diagnostics = parseRegexFixture(
            'test',
            {
                pattern: String.raw`(?<line>\S+):(?<col>\S+):(?<endLine>\S+):(?<endCol>\S+):(?<message>[^\n]+)`,
                flags: 'gm',
            },
            [
                '4:2:4:5:Valid',
                'nope:2:4:5:Bad line',
                '5:bad:5:7:Bad col',
                '6:3:end:7:Bad end line',
                '7:4:7:oops:Bad end col',
            ].join('\n')
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 3);
        assert.strictEqual(diagnostics[0].range.start.character, 1);
        assert.strictEqual(diagnostics[0].message, 'Valid');
    });

    test('partially numeric line captures are skipped', () => {
        const diagnostics = parseRegexFixture(
            'test',
            { pattern: String.raw`^(?<line>[^:\n]+):(?<message>[^\n]+)$`, flags: 'gm' },
            '12x:Broken\n8:Valid'
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 7);
        assert.strictEqual(diagnostics[0].message, 'Valid');
    });
});

suite('Regex Utility Parser Configs', () => {
    test('shellcheck gcc format', () => {
        const output = [
            'lint-test/test.sh:7:16: note: Double quote to prevent globbing and word splitting. [SC2086]',
            'lint-test/test.sh:7:16: note: Prefer putting braces around variable references even when not strictly required. [SC2250]',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'Shell Check',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<severity>\w+): (?<message>.+?) \[(?<code>SC\d+)\]$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].range.start.line, 6);
        assert.strictEqual(diagnostics[0].range.start.character, 15);
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Information);
        assert.strictEqual(diagnostics[0].code, 'SC2086');
    });

    test('hadolint tty format', () => {
        const output = [
            'lint-test/Dockerfile:4 DL3007 warning: Using latest is prone to errors if the image will ever update. Pin the version explicitly to a release tag',
            'lint-test/Dockerfile:12 DL3025 error: Use arguments JSON notation for CMD and ENTRYPOINT arguments',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'HadoLint',
            {
                pattern: String.raw`^.+?:(?<line>\d+) (?<code>\S+) (?<severity>\w+): (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[1].range.start.line, 11);
        assert.strictEqual(diagnostics[1].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diagnostics[1].code, 'DL3025');
    });

    test('markdownlint default format', () => {
        const output =
            'lint-test/test.md:9:1 error MD029/ol-prefix Ordered list item prefix [Expected: 3; Actual: 1; Style: 1/2/3]';
        const diagnostics = parseRegexFixture(
            'Markdown Lint',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+) (?<severity>\w+) (?<code>[A-Z0-9]+)(?:/\S+)? (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].code, 'MD029');
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('yamllint parsable format', () => {
        const output = 'lint-test/test.yml:1:1: [warning] missing document start "---" (document-start)';
        const diagnostics = parseRegexFixture(
            'YAML Lint',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): \[(?<severity>\w+)\] (?<message>.+?) \((?<code>[^)]+)\)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].code, 'document-start');
        assert.strictEqual(diagnostics[0].message, 'missing document start "---"');
    });

    test('ansible-lint full format', () => {
        const output = [
            'fqcn[action-core]: Use FQCN for builtin module actions (debug).',
            'lint-test/ansible.yml:8:7 Use `ansible.builtin.debug` or `ansible.legacy.debug` instead.',
            '',
            'no-changed-when: Commands should not change things if nothing needs doing.',
            'lint-test/ansible.yml:10 Task/Handler: shell echo done',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'Ansible Lint',
            {
                pattern: String.raw`^(?<code>[a-z][\w.\[\]-]+): (?<message>.+)\n.+?:(?<line>\d+)(?::(?<col>\d+))?`,
                flags: 'gm',
                defaultSeverity: 'warning',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].range.start.line, 7);
        assert.strictEqual(diagnostics[0].range.start.character, 6);
        assert.strictEqual(diagnostics[0].code, 'fqcn[action-core]');
        assert.strictEqual(diagnostics[1].range.start.line, 9);
        assert.strictEqual(diagnostics[1].code, 'no-changed-when');
    });

    test('ruff github format', () => {
        const output =
            '::error title=ruff (F841),file=/home/vix/Code/lint-runner/lint-test/test.py,line=2,col=5,endLine=2,endColumn=6::lint-test/test.py:2:5: F841 Local variable `x` is assigned to but never used%0A  help: Remove assignment to unused variable `x`';
        const diagnostics = parseRegexFixture(
            'Ruff',
            {
                pattern: String.raw`^::(?<severity>error|warning) title=ruff \((?<code>[^)]+)\),file=[^,]+,line=(?<line>\d+),col=(?<col>\d+),endLine=(?<endLine>\d+),endColumn=(?<endCol>\d+)::(?:[^:]+:\d+:\d+: [A-Z]\d+ )?(?<message>[^\n%]+)`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.character, 4);
        assert.strictEqual(diagnostics[0].range.end.line, 1);
        assert.strictEqual(diagnostics[0].range.end.character, 5);
        assert.strictEqual(diagnostics[0].code, 'F841');
        assert.strictEqual(diagnostics[0].message, 'Local variable `x` is assigned to but never used');
    });

    test('dotenv plain format', () => {
        const output = [
            'Checking lint-test/.env',
            'lint-test/.env:1 LowercaseKey: The app_name key should be in uppercase',
            'lint-test/.env:2 IncorrectDelimiter: The APP ENV key has incorrect delimiter',
            '',
            'Found 2 problems',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'Dotenv',
            {
                pattern: String.raw`^.+?:(?<line>\d+) (?<code>[A-Za-z][\w-]*): (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].code, 'LowercaseKey');
        assert.strictEqual(diagnostics[1].range.start.line, 1);
    });

    test('luacheck plain format', () => {
        const output = [
            "/tmp/lint-runner-test.lua:1:7: (W211) unused variable 'unused'",
            "/tmp/lint-runner-test.lua:2:7: (W113) accessing undefined variable 'unknown'",
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'LuaCheck',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): \((?<code>[A-Z]\d+)\) (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].code, 'W211');
        assert.strictEqual(diagnostics[1].range.start.character, 6);
    });

    test('taplo syntax format', () => {
        const output = [
            'error: invalid TOML',
            '  \u250c\u2500 /tmp/test.toml:1:5',
            '  |',
            '1 | x = ]',
            '  |     ^ expected value',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'Taplo',
            {
                pattern: String.raw`(?<severity>error|warning|info):\s*(?<message>[^\n]+)[\s\S]*?\u250c\u2500\s+[^:\n]+:(?<line>\d+):(?<col>\d+)`,
            },
            output
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 0);
        assert.strictEqual(diagnostics[0].range.start.character, 4);
        assert.strictEqual(diagnostics[0].message, 'invalid TOML');
    });

    test('eslint stylish format', () => {
        const output = [
            '/home/vix/Code/lint-runner/lint-test/test.js',
            "  2:7  error    'unused' is assigned a value but never used  no-unused-vars",
            '  8:1  warning  Unexpected console statement                 no-console',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'ESLint',
            {
                pattern: String.raw`^\s*(?<line>\d+):(?<col>\d+)\s+(?<severity>error|warning)\s+(?<message>.+?)\s{2,}(?<code>\S+)\s*$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diagnostics[1].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diagnostics[1].code, 'no-console');
    });

    test('stylelint compact format', () => {
        const output =
            '/home/vix/Code/lint-runner/lint-test/test.css: line 6, col 12, error - Disallowed named color "red" (color-named)';
        const diagnostics = parseRegexFixture(
            'Style',
            {
                pattern: String.raw`^.+?: line (?<line>\d+), col (?<col>\d+), (?<severity>\w+) - (?<message>.+?) \((?<code>[^)]+)\)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 5);
        assert.strictEqual(diagnostics[0].code, 'color-named');
    });

    test('linthtml no-color format', () => {
        const output = [
            ' 2:1  error  <HTML> tag should specify the language of the page using the "lang" attribute  html-req-lang      ',
            ' 8:9  error  Invalid case for tag <h1>, tag names must be written in lowercase              tag-name-lowercase ',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'HTML',
            {
                pattern: String.raw`^\s*(?<line>\d+):(?<col>\d+)\s+(?<severity>error|warning)\s+(?<message>.+?)\s{2,}(?<code>\S+)\s*$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].code, 'html-req-lang');
        assert.strictEqual(diagnostics[1].range.start.character, 8);
    });

    test('htmlhint unix format', () => {
        const output = [
            '/home/vix/Code/lint-runner/lint-test/test.html:2:6: An lang attribute must be present on <html> elements. [warning/html-lang-require]',
            '/home/vix/Code/lint-runner/lint-test/test.html:8:9: The html element name of [ H1 ] must be in lowercase. [error/tagname-lowercase]',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'HTML Hint',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<message>.+) \[(?<severity>[^/\]]+)/(?<code>[^\]]+)\]$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diagnostics[1].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diagnostics[1].code, 'tagname-lowercase');
    });

    test('sqlfluff github annotation native format', () => {
        const output = [
            '::warning title=SQLFluff,file=lint-test/test.sql,line=1,col=1,endLine=1,endColumn=7::CP01: Keywords must be upper case. [capitalisation.keywords]',
            "::warning title=SQLFluff,file=lint-test/test.sql,line=1,col=35,endLine=1,endColumn=40::LT14: The 'where' keyword should always start a new line. [layout.keyword_newline]",
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'Sql Fluff',
            {
                pattern: String.raw`^::(?<severity>error|warning|notice) title=SQLFluff,file=[^,]+,line=(?<line>\d+),col=(?<col>\d+),endLine=(?<endLine>\d+),endColumn=(?<endCol>\d+)::(?<code>[A-Z]+\d+): (?<message>.+?)(?: \[[^\]]+\])?$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].code, 'CP01');
        assert.strictEqual(diagnostics[1].range.start.character, 34);
        assert.strictEqual(diagnostics[1].range.end.character, 39);
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
        const diagnostics = parseRegexFixture(
            'Check Make',
            {
                pattern: String.raw`\{\s*"rule":\s*"(?<code>[^"]+)",\s*"violation":\s*"(?<message>(?:\\.|[^"])*)",\s*"file_name":\s*"[^"]+",\s*"line_number":\s*(?<line>\d+)\s*\}`,
                messageFormat: 'json',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].code, 'phonydeclared');
        assert.strictEqual(diagnostics[1].message, 'Required target "clean" must be declared PHONY.');
    });

    test('nginx-lint errorformat', () => {
        const output = [
            "/tmp/lint-runner-nginx.conf:1:1: error[syntax/invalid-directive-context]: 'server' directive must be inside one of: http, stream, mail, not in main context",
            '/tmp/lint-runner-nginx.conf:2:13: error[syntax/missing-semicolon]: Missing semicolon at end of directive',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'Nginx',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<severity>\w+)\[(?<code>[^\]]+)\]: (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diagnostics[0].code, 'syntax/invalid-directive-context');
    });

    test('xmllint stderr format', () => {
        const stderr = [
            'lint-test/test.xml:6: parser error : Opening and ending tag mismatch: value line 5 and item',
            '    </item>',
            '           ^',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'XML',
            {
                pattern: String.raw`^.+?:(?<line>\d+): (?:(?:parser )?(?<severity>error|warning)) : (?<message>.+)$`,
                flags: 'gm',
                output: 'stderr',
            },
            '',
            stderr
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 5);
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
    });

    test('jsonlint single-line format', () => {
        const output = 'lint-test/test.json: line 4, col 11, Duplicate key: "name".';
        const diagnostics = parseRegexFixture(
            'JSON',
            {
                pattern: String.raw`^(?:.+?:\s*)?line\s+(?<line>\d+),\s*col\s+(?<col>\d+),\s*(?<message>.+?)(?:\.)?$`,
                flags: 'gm',
                defaultSeverity: 'error',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.character, 10);
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diagnostics[0].message, 'Duplicate key: "name"');
    });

    test('actionlint default format', () => {
        const output = [
            'lint-test/.github/workflows/test.yml:14:9: step must run script with "run" section or run action with "uses" section [syntax-check]',
            "lint-test/.github/workflows/test.yml:15:29: got unexpected character ' ' while lexing == operator, expecting '=' [expression]",
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'Action',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<message>.+?) \[(?<code>[^\]]+)\]$`,
                flags: 'gm',
                defaultSeverity: 'error',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].code, 'syntax-check');
        assert.strictEqual(diagnostics[1].range.start.character, 28);
        assert.strictEqual(diagnostics[1].severity, vscode.DiagnosticSeverity.Error);
    });

    test('phpcs emacs format', () => {
        const output = [
            '/home/vix/Code/lint-runner/lint-test/test.php:1:1: warning - A file should declare new symbols and cause no other side effects.',
            '/home/vix/Code/lint-runner/lint-test/test.php:1:1: error - Missing declare(strict_types=1).',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'PHP CodeSniffer',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<col>\d+): (?<severity>warning|error) - (?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diagnostics[1].severity, vscode.DiagnosticSeverity.Error);
    });

    test('phpmd text format', () => {
        const output = [
            "/home/vix/Code/lint-runner/lint-test/test.php:5  UnusedLocalVariable  Avoid unused local variables such as '$unused'.",
            "/home/vix/Code/lint-runner/lint-test/test.php:6  UnusedLocalVariable  Avoid unused local variables such as '$magic'.",
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'PHP Mess Detector',
            {
                pattern: String.raw`^.+?:(?<line>\d+)\s+(?<code>\S+)\s+(?<message>.+)$`,
                flags: 'gm',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].range.start.line, 4);
        assert.strictEqual(diagnostics[0].code, 'UnusedLocalVariable');
    });

    test('phpstan raw format', () => {
        const output = [
            'Instructions for interpreting errors',
            '---------',
            '/home/vix/Code/lint-runner/lint-test/test.php:3:Function greet() has no return type specified. [identifier=missingType.return]',
            '/home/vix/Code/lint-runner/lint-test/test.php:10:Parameter #1 (mixed) of echo cannot be converted to string. [identifier=echo.nonString]',
        ].join('\n');
        const diagnostics = parseRegexFixture(
            'PHPStan',
            {
                pattern: String.raw`^.+?:(?<line>\d+):(?<message>.+?)(?: \[identifier=(?<code>[^\]]+)\])?$`,
                flags: 'gm',
                defaultSeverity: 'error',
            },
            output
        );

        assert.strictEqual(diagnostics.length, 2);
        assert.strictEqual(diagnostics[0].range.start.line, 2);
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diagnostics[0].code, 'missingType.return');
    });
});
