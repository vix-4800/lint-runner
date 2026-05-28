import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    cancelAllFileRuns,
    cancelFileRun,
    clearAllFileLinterDiagnostics,
    clearDiagnosticsCache,
    collectDoctorToolStatuses,
    runPipeline,
    runFixers,
    runLinters,
    runRunnableLinters,
    type RunnablePipeline,
    type RunnableFixer,
    type ResolvedTargetConfig,
    type RunnableLinter,
} from '../linterRunner.js';

const SLOW_LINTER_TIMEOUT_MS = 10_000;

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fs.access(filePath);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    throw new Error(`Timed out waiting for file ${filePath}`);
}

async function assertCancelledProcess(completedMarkerPath: string, terminatedMarkerPath?: string): Promise<void> {
    if (terminatedMarkerPath !== undefined && process.platform !== 'win32') {
        await waitForFile(terminatedMarkerPath, 1_000);
    }
    await assert.rejects(fs.access(completedMarkerPath));
}

async function assertSamePath(actualPath: string, expectedPath: string): Promise<void> {
    assert.strictEqual(await fs.realpath(actualPath), await fs.realpath(expectedPath));
}

suite('Linter Runner Test Suite', () => {
    test('runPipeline sequence stops after a failed tool', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-pipeline-'));
        const markerPath = path.join(tmpDir, 'should-not-exist');
        const filePath = path.join(tmpDir, 'file.js');
        await fs.writeFile(filePath, 'const a = 1;');
        const outputLines: string[] = [];
        const pipeline: RunnablePipeline = {
            label: 'JS: manual',
            description: 'sequence',
            detail: 'fail, later',
            target: { name: 'JS', match: { files: ['*.js'] } },
            pipelineName: 'manual',
            pipeline: { strategy: 'sequence', tools: ['fail', 'later'] },
            tools: [
                {
                    label: 'fail',
                    description: 'JS / manual',
                    detail: 'write',
                    targetName: 'JS',
                    pipelineName: 'manual',
                    toolName: 'fail',
                    tool: {
                        kind: 'write',
                        command: process.execPath,
                        args: ['-e', 'process.exit(7)'],
                        successExitCodes: [0],
                    },
                },
                {
                    label: 'later',
                    description: 'JS / manual',
                    detail: 'write',
                    targetName: 'JS',
                    pipelineName: 'manual',
                    toolName: 'later',
                    tool: {
                        kind: 'write',
                        command: process.execPath,
                        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
                    },
                },
            ],
        };

        const statusBar = { text: '', show() { /* test stub */ }, hide() { /* test stub */ } } as vscode.StatusBarItem;
        const runCount = await runPipeline(
            filePath,
            pipeline,
            { appendLine: (line: string) => outputLines.push(line) },
            statusBar
        );

        assert.strictEqual(runCount, 0);
        await assert.rejects(fs.access(markerPath));
        assert.match(outputLines.join('\n'), /exit 7 is not in successExitCodes/);
    });

    test('runPipeline parses diagnostic tool output', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-diagnostic-'));
        const filePath = path.join(tmpDir, 'file.js');
        await fs.writeFile(filePath, 'const a = 1;');
        const diagnostics = {
            entries: new Map<string, vscode.Diagnostic[]>(),
            set(uri: vscode.Uri, values: vscode.Diagnostic[]) {
                this.entries.set(uri.toString(), values);
            },
            delete(uri: vscode.Uri) {
                this.entries.delete(uri.toString());
            },
        };
        const pipeline: RunnablePipeline = {
            label: 'JS: manual',
            description: 'sequence',
            detail: 'eslint',
            target: { name: 'JS' },
            pipelineName: 'manual',
            pipeline: { strategy: 'sequence', tools: ['eslint'] },
            tools: [
                {
                    label: 'eslint',
                    description: 'JS / manual',
                    detail: 'diagnostic',
                    targetName: 'JS',
                    pipelineName: 'manual',
                    toolName: 'eslint',
                    tool: {
                        kind: 'diagnostic',
                        command: process.execPath,
                        args: ['-e', 'console.log("2:3:error:Bad rule-id")'],
                        parser: {
                            pattern: '(?<line>\\d+):(?<col>\\d+):(?<severity>\\w+):(?<message>.+?) (?<code>\\S+)',
                        },
                    },
                },
            ],
        };

        const statusBar = { text: '', show() { /* test stub */ }, hide() { /* test stub */ } } as vscode.StatusBarItem;
        const runCount = await runPipeline(
            filePath,
            pipeline,
            { appendLine() { /* test stub */ } },
            statusBar,
            diagnostics as unknown as vscode.DiagnosticCollection
        );

        const published = diagnostics.entries.get(vscode.Uri.file(filePath).toString()) ?? [];
        assert.strictEqual(runCount, 1);
        assert.strictEqual(published.length, 1);
        assert.strictEqual(published[0]?.source, 'eslint');
        assert.strictEqual(published[0]?.code, 'rule-id');
    });

    test('collectDoctorToolStatuses groups tools by target and resolves found/version state', async () => {
        const statuses = await collectDoctorToolStatuses(
            [
                {
                    name: 'PHP',
                    filePatterns: [],
                    languages: ['php'],
                    preCommands: [],
                    linters: [
                        {
                            name: 'phpstan',
                            command: 'phpstan',
                            args: ['analyse'],
                            parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                            filePatterns: [],
                            languages: ['php'],
                            run: 'manual',
                        },
                        {
                            name: 'phpcs',
                            command: 'phpcs',
                            args: ['--report=emacs'],
                            parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                            filePatterns: [],
                            languages: ['php'],
                            run: 'manual',
                            preCommands: [{ command: 'phpcs', args: ['--config-show'] }],
                        },
                    ],
                    fixers: [{ name: 'mago', command: 'mago', args: ['fix'] }],
                },
                {
                    name: 'Shell',
                    filePatterns: [],
                    languages: ['shellscript'],
                    preCommands: [],
                    linters: [
                        {
                            name: 'shellcheck',
                            command: 'shellcheck',
                            args: ['--format=gcc'],
                            parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                            filePatterns: [],
                            languages: ['shellscript'],
                            run: 'manual',
                        },
                    ],
                    fixers: [],
                },
            ],
            {
                checkCommand: (command) => {
                    if (command === 'mago') {
                        return false;
                    }
                    return true;
                },
                detectVersion: async (command) => ({ phpcs: '3.10.2', phpstan: '2.1.18', shellcheck: '0.10.0' })[command],
            }
        );

        assert.deepStrictEqual(statuses, [
            { tool: 'mago', found: 'no', version: '-', usedBy: ['PHP'] },
            { tool: 'phpcs', found: 'yes', version: '3.10.2', usedBy: ['PHP'] },
            { tool: 'phpstan', found: 'yes', version: '2.1.18', usedBy: ['PHP'] },
            { tool: 'shellcheck', found: 'yes', version: '0.10.0', usedBy: ['Shell'] },
        ]);
    });

    test('cancelFileRun stops active linter processes for the closed file', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-cancel-'));
        const filePath = path.join(tmpDir, 'test.ts');
        const scriptPath = path.join(tmpDir, 'slow-linter.js');
        const startedMarkerPath = path.join(tmpDir, 'started.txt');
        const terminatedMarkerPath = path.join(tmpDir, 'terminated.txt');
        const completedMarkerPath = path.join(tmpDir, 'completed.txt');
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(
            scriptPath,
            [
                "const fs = require('node:fs');",
                'const [startedMarkerPath, terminatedMarkerPath, completedMarkerPath] = process.argv.slice(2);',
                "fs.writeFileSync(startedMarkerPath, 'started');",
                "process.on('SIGTERM', () => {",
                "    fs.writeFileSync(terminatedMarkerPath, 'terminated');",
                '    process.exit(0);',
                '});',
                'setTimeout(() => {',
                "    fs.writeFileSync(completedMarkerPath, 'completed');",
                '    process.exit(0);',
                `}, ${SLOW_LINTER_TIMEOUT_MS});`,
                '',
            ].join('\n')
        );

        const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner-cancel-test');
        const output = vscode.window.createOutputChannel('LintRunner Cancel Test');
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

        const target: ResolvedTargetConfig = {
            name: 'cancel-test-target',
            filePatterns: [],
            languages: ['typescript'],
            preCommands: [],
            linters: [],
            fixers: [],
        };
        const runnable: RunnableLinter = {
            label: 'slow-linter',
            description: target.name,
            detail: process.execPath,
            target,
            linter: {
                name: 'slow-linter',
                command: process.execPath,
                args: [
                    scriptPath,
                    startedMarkerPath,
                    terminatedMarkerPath,
                    completedMarkerPath,
                ],
                parser: {
                    pattern: '(?<line>\\d+):(?<message>.+)',
                },
                run: 'manual',
            },
        };

        try {
            const runPromise = runRunnableLinters(filePath, diagnostics, output, statusBar, [runnable]);
            await waitForFile(startedMarkerPath, 5_000);

            cancelFileRun(filePath);

            await Promise.race([
                runPromise,
                new Promise<never>((_, reject) => {
                    setTimeout(() => {
                        reject(new Error('Timed out waiting for cancelled linter run to finish'));
                    }, 3_000);
                }),
            ]);
            assert.strictEqual(diagnostics.get(vscode.Uri.file(filePath))?.length ?? 0, 0);
            await assertCancelledProcess(completedMarkerPath, terminatedMarkerPath);
        } finally {
            cancelFileRun(filePath);
            diagnostics.dispose();
            output.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('cancelAllFileRuns stops active linter processes for all files', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-cancel-all-'));
        const firstFilePath = path.join(tmpDir, 'first.ts');
        const secondFilePath = path.join(tmpDir, 'second.ts');
        const scriptPath = path.join(tmpDir, 'slow-linter.js');
        const firstStartedMarkerPath = path.join(tmpDir, 'first-started.txt');
        const firstTerminatedMarkerPath = path.join(tmpDir, 'first-terminated.txt');
        const firstCompletedMarkerPath = path.join(tmpDir, 'first-completed.txt');
        const secondStartedMarkerPath = path.join(tmpDir, 'second-started.txt');
        const secondTerminatedMarkerPath = path.join(tmpDir, 'second-terminated.txt');
        const secondCompletedMarkerPath = path.join(tmpDir, 'second-completed.txt');
        await fs.writeFile(firstFilePath, 'const first = 1;\n');
        await fs.writeFile(secondFilePath, 'const second = 2;\n');
        await fs.writeFile(
            scriptPath,
            [
                "const fs = require('node:fs');",
                'const [startedMarkerPath, terminatedMarkerPath, completedMarkerPath] = process.argv.slice(2);',
                "fs.writeFileSync(startedMarkerPath, 'started');",
                "process.on('SIGTERM', () => {",
                "    fs.writeFileSync(terminatedMarkerPath, 'terminated');",
                '    process.exit(0);',
                '});',
                'setTimeout(() => {',
                "    fs.writeFileSync(completedMarkerPath, 'completed');",
                '    process.exit(0);',
                `}, ${SLOW_LINTER_TIMEOUT_MS});`,
                '',
            ].join('\n')
        );

        const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner-cancel-all-test');
        const output = vscode.window.createOutputChannel('LintRunner Cancel All Test');
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

        const target: ResolvedTargetConfig = {
            name: 'cancel-all-test-target',
            filePatterns: [],
            languages: ['typescript'],
            preCommands: [],
            linters: [],
            fixers: [],
        };
        const createRunnable = (
            label: string,
            startedMarkerPath: string,
            terminatedMarkerPath: string,
            completedMarkerPath: string
        ): RunnableLinter => ({
            label,
            description: target.name,
            detail: process.execPath,
            target,
            linter: {
                name: label,
                command: process.execPath,
                args: [
                    scriptPath,
                    startedMarkerPath,
                    terminatedMarkerPath,
                    completedMarkerPath,
                ],
                parser: {
                    pattern: '(?<line>\\d+):(?<message>.+)',
                },
                run: 'manual',
            },
        });

        try {
            const firstRunPromise = runRunnableLinters(firstFilePath, diagnostics, output, statusBar, [
                createRunnable(
                    'slow-linter-first',
                    firstStartedMarkerPath,
                    firstTerminatedMarkerPath,
                    firstCompletedMarkerPath
                ),
            ]);
            const secondRunPromise = runRunnableLinters(secondFilePath, diagnostics, output, statusBar, [
                createRunnable(
                    'slow-linter-second',
                    secondStartedMarkerPath,
                    secondTerminatedMarkerPath,
                    secondCompletedMarkerPath
                ),
            ]);

            await Promise.all([
                waitForFile(firstStartedMarkerPath, 5_000),
                waitForFile(secondStartedMarkerPath, 5_000),
            ]);

            cancelAllFileRuns();

            await Promise.race([
                Promise.all([firstRunPromise, secondRunPromise]),
                new Promise<never>((_, reject) => {
                    setTimeout(() => {
                        reject(new Error('Timed out waiting for cancelled linter runs to finish'));
                    }, 3_000);
                }),
            ]);

            assert.strictEqual(diagnostics.get(vscode.Uri.file(firstFilePath))?.length ?? 0, 0);
            assert.strictEqual(diagnostics.get(vscode.Uri.file(secondFilePath))?.length ?? 0, 0);
            await Promise.all([
                assertCancelledProcess(firstCompletedMarkerPath, firstTerminatedMarkerPath),
                assertCancelledProcess(secondCompletedMarkerPath, secondTerminatedMarkerPath),
            ]);
        } finally {
            cancelAllFileRuns();
            diagnostics.dispose();
            output.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runLinters keeps diagnostics and cache separate for targets sharing a linter name', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-shared-linter-'));
        const filePath = path.join(tmpDir, 'test.ts');
        const scriptPath = path.join(tmpDir, 'emit-diagnostic.js');
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(
            scriptPath,
            [
                'const [message] = process.argv.slice(2);',
                "process.stdout.write(`1:${message}\\n`);",
                '',
            ].join('\n')
        );

        const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner-shared-linter-test');
        const output = vscode.window.createOutputChannel('LintRunner Shared Linter Test');
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        const config = vscode.workspace.getConfiguration('lintRunner');
        const previousTargets = config.inspect<unknown[]>('targets')?.globalValue;
        const expectedMessages = ['backend issue', 'frontend issue'];

        try {
            const document = await vscode.workspace.openTextDocument(filePath);
            const resolvedFilePath = document.fileName;
            const uri = document.uri;
            clearAllFileLinterDiagnostics();
            clearDiagnosticsCache();

            await config.update(
                'targets',
                [
                    {
                        name: 'frontend',
                        languages: ['typescript'],
                        linters: [
                            {
                                name: 'shared-linter',
                                command: process.execPath,
                                args: [scriptPath, 'frontend issue'],
                                parser: {
                                    pattern: '(?<line>\\d+):(?<message>.+)',
                                },
                                run: 'onSave',
                            },
                        ],
                    },
                    {
                        name: 'backend',
                        languages: ['typescript'],
                        linters: [
                            {
                                name: 'shared-linter',
                                command: process.execPath,
                                args: [scriptPath, 'backend issue'],
                                parser: {
                                    pattern: '(?<line>\\d+):(?<message>.+)',
                                },
                                run: 'onSave',
                            },
                        ],
                    },
                ],
                vscode.ConfigurationTarget.Global
            );

            await runLinters(resolvedFilePath, 'onSave', diagnostics, output, statusBar);
            assert.deepStrictEqual(
                (diagnostics.get(uri) ?? []).map((diagnostic) => diagnostic.message).sort(),
                expectedMessages
            );

            await runLinters(resolvedFilePath, 'onSave', diagnostics, output, statusBar);
            assert.deepStrictEqual(
                (diagnostics.get(uri) ?? []).map((diagnostic) => diagnostic.message).sort(),
                expectedMessages
            );
        } finally {
            clearAllFileLinterDiagnostics();
            clearDiagnosticsCache();
            await config.update('targets', previousTargets, vscode.ConfigurationTarget.Global);
            diagnostics.dispose();
            output.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runRunnableLinters accepts configured non-zero successExitCodes', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-linter-exit-codes-'));
        const filePath = path.join(tmpDir, 'test.ts');
        const scriptPath = path.join(tmpDir, 'emit-diagnostic.js');
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(
            scriptPath,
            [
                "process.stdout.write('1:configured success\\n');",
                'process.exit(1);',
                '',
            ].join('\n')
        );

        const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner-linter-exit-codes-test');
        const output = vscode.window.createOutputChannel('LintRunner Linter Exit Codes Test');
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        const target: ResolvedTargetConfig = {
            name: 'exit-code-test-target',
            filePatterns: [],
            languages: ['typescript'],
            preCommands: [],
            linters: [],
            fixers: [],
        };
        const runnable: RunnableLinter = {
            label: 'configured-exit-linter',
            description: target.name,
            detail: process.execPath,
            target,
            linter: {
                name: 'configured-exit-linter',
                command: process.execPath,
                args: [scriptPath],
                parser: {
                    pattern: '(?<line>\\d+):(?<message>.+)',
                },
                successExitCodes: [1],
                run: 'manual',
            },
        };

        try {
            const lintersRun = await runRunnableLinters(filePath, diagnostics, output, statusBar, [runnable]);
            const messages = (diagnostics.get(vscode.Uri.file(filePath)) ?? []).map((diagnostic) => diagnostic.message);

            assert.strictEqual(lintersRun, 1);
            assert.deepStrictEqual(messages, ['configured success']);
        } finally {
            diagnostics.dispose();
            output.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runRunnableLinters reports failures outside successExitCodes', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-linter-failure-report-'));
        const filePath = path.join(tmpDir, 'test.ts');
        const scriptPath = path.join(tmpDir, 'fail-linter.js');
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(scriptPath, 'process.exit(2);\n');

        const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner-linter-failure-report-test');
        const failures: Array<{ label: string; message: string }> = [];
        const output = {
            appendLine() {
                // no-op
            },
            reportFailure(failure: { label: string; message: string }) {
                failures.push(failure);
            },
        };
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        const target: ResolvedTargetConfig = {
            name: 'PHP',
            filePatterns: [],
            languages: ['typescript'],
            preCommands: [],
            linters: [],
            fixers: [],
        };
        const runnable: RunnableLinter = {
            label: 'phpstan',
            description: target.name,
            detail: process.execPath,
            target,
            linter: {
                name: 'phpstan',
                command: process.execPath,
                args: [scriptPath],
                parser: {
                    pattern: '(?<line>\\d+):(?<message>.+)',
                },
                successExitCodes: [0, 1],
                run: 'manual',
            },
        };

        try {
            await runRunnableLinters(filePath, diagnostics, output, statusBar, [runnable]);
            assert.deepStrictEqual(failures, [
                {
                    label: 'PHP:phpstan',
                    message: 'exit 2 is not in successExitCodes [0, 1]',
                },
            ]);
        } finally {
            diagnostics.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runRunnableLinters uses configured cwd and env for linter commands and pre-commands', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-linter-cwd-'));
        const fileDir = path.join(tmpDir, 'nested');
        const filePath = path.join(fileDir, 'test.ts');
        const scriptPath = path.join(tmpDir, 'record-command-state.js');
        const preCommandMarkerPath = path.join(tmpDir, 'pre-command-state.json');
        const linterMarkerPath = path.join(tmpDir, 'linter-state.json');
        await fs.mkdir(fileDir, { recursive: true });
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(
            scriptPath,
            [
                "const fs = require('node:fs');",
                'const [markerPath, envName] = process.argv.slice(2);',
                'fs.writeFileSync(markerPath, JSON.stringify({ cwd: process.cwd(), envValue: envName ? process.env[envName] ?? "" : "" }));',
                'process.exit(0);',
                '',
            ].join('\n')
        );

        const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner-linter-cwd-test');
        const output = vscode.window.createOutputChannel('LintRunner Linter Cwd Test');
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        const target: ResolvedTargetConfig = {
            name: 'TypeScript',
            filePatterns: [],
            languages: ['typescript'],
            preCommands: [],
            linters: [],
            fixers: [],
        };
        const runnable: RunnableLinter = {
            label: 'cwd-linter',
            description: target.name,
            detail: process.execPath,
            target,
            linter: {
                name: 'cwd-linter',
                command: process.execPath,
                args: [scriptPath, linterMarkerPath, 'LINT_RUNNER_MAIN_ENV'],
                cwd: '${fileDirname}',
                env: { LINT_RUNNER_MAIN_ENV: '${fileBasename}' },
                parser: {
                    pattern: '(?<line>\\d+):(?<message>.+)',
                },
                preCommands: [
                    {
                        command: process.execPath,
                        args: [scriptPath, preCommandMarkerPath, 'LINT_RUNNER_PRE_ENV'],
                        cwd: tmpDir,
                        env: { LINT_RUNNER_PRE_ENV: 'pre-value' },
                    },
                ],
                run: 'manual',
            },
        };

        try {
            const lintersRun = await runRunnableLinters(filePath, diagnostics, output, statusBar, [runnable]);
            const preCommandState = JSON.parse(await fs.readFile(preCommandMarkerPath, 'utf8')) as {
                cwd: string;
                envValue: string;
            };
            const linterState = JSON.parse(await fs.readFile(linterMarkerPath, 'utf8')) as {
                cwd: string;
                envValue: string;
            };

            assert.strictEqual(lintersRun, 1);
            await assertSamePath(preCommandState.cwd, tmpDir);
            assert.strictEqual(preCommandState.envValue, 'pre-value');
            await assertSamePath(linterState.cwd, fileDir);
            assert.strictEqual(linterState.envValue, 'test.ts');
        } finally {
            diagnostics.dispose();
            output.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runFixers shows the active fixer name in the status bar', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-fixer-status-'));
        const filePath = path.join(tmpDir, 'test.ts');
        const scriptPath = path.join(tmpDir, 'wait-for-release.js');
        const startedMarkerPath = path.join(tmpDir, 'started.txt');
        const releaseMarkerPath = path.join(tmpDir, 'release.txt');
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(
            scriptPath,
            [
                "const fs = require('node:fs');",
                "const [startedMarkerPath, releaseMarkerPath] = process.argv.slice(2);",
                "fs.writeFileSync(startedMarkerPath, 'started');",
                'const timer = setInterval(() => {',
                '    if (!fs.existsSync(releaseMarkerPath)) {',
                '        return;',
                '    }',
                '    clearInterval(timer);',
                '    process.exit(0);',
                '}, 25);',
                '',
            ].join('\n')
        );

        const output = vscode.window.createOutputChannel('LintRunner Fixer Status Test');
        let shown = false;
        const statusBar = {
            hide() {
                shown = false;
            },
            show() {
                shown = true;
            },
            text: '',
            tooltip: '',
            name: '',
        } as unknown as vscode.StatusBarItem;
        const fixer: RunnableFixer = {
            label: 'php-cs-fixer',
            description: 'PHP',
            detail: process.execPath,
            targetName: 'PHP',
            fixer: {
                name: 'php-cs-fixer',
                command: process.execPath,
                args: [scriptPath, startedMarkerPath, releaseMarkerPath],
            },
        };

        try {
            const runPromise = runFixers(filePath, output, statusBar, 'manual', [fixer]);

            await waitForFile(startedMarkerPath, 5_000);

            assert.strictEqual(statusBar.text, '$(sync~spin) LintRunner: PHP:fix:php-cs-fixer');
            assert.strictEqual(
                statusBar.tooltip,
                'Running tools: PHP:fix:php-cs-fixer\nClick to stop all running tools.'
            );
            assert.strictEqual(shown, true);

            await fs.writeFile(releaseMarkerPath, 'release');
            const fixersRun = await runPromise;

            assert.strictEqual(fixersRun, 1);
            assert.strictEqual(shown, false);
        } finally {
            output.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runFixers stops remaining fixers when exit code is not allowed', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-fixer-exit-codes-'));
        const filePath = path.join(tmpDir, 'test.ts');
        const failingScriptPath = path.join(tmpDir, 'failing-fixer.js');
        const quickScriptPath = path.join(tmpDir, 'quick-fixer.js');
        const firstStartedMarkerPath = path.join(tmpDir, 'first-started.txt');
        const secondStartedMarkerPath = path.join(tmpDir, 'second-started.txt');
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(
            failingScriptPath,
            [
                "const fs = require('node:fs');",
                'const [startedMarkerPath] = process.argv.slice(2);',
                "fs.writeFileSync(startedMarkerPath, 'started');",
                'process.exit(2);',
                '',
            ].join('\n')
        );
        await fs.writeFile(
            quickScriptPath,
            [
                "const fs = require('node:fs');",
                'const [startedMarkerPath] = process.argv.slice(2);',
                "fs.writeFileSync(startedMarkerPath, 'started');",
                'process.exit(0);',
                '',
            ].join('\n')
        );

        const output = vscode.window.createOutputChannel('LintRunner Fixer Exit Codes Test');
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        const failingFixer: RunnableFixer = {
            label: 'failing-fixer',
            description: 'PHP',
            detail: process.execPath,
            targetName: 'PHP',
            fixer: {
                name: 'failing-fixer',
                command: process.execPath,
                args: [failingScriptPath, firstStartedMarkerPath],
                successExitCodes: [0, 1],
            },
        };
        const quickFixer: RunnableFixer = {
            label: 'quick-fixer',
            description: 'PHP',
            detail: process.execPath,
            targetName: 'PHP',
            fixer: {
                name: 'quick-fixer',
                command: process.execPath,
                args: [quickScriptPath, secondStartedMarkerPath],
            },
        };

        try {
            const fixersRun = await runFixers(filePath, output, statusBar, 'manual', [failingFixer, quickFixer]);

            await fs.access(firstStartedMarkerPath);
            await assert.rejects(fs.access(secondStartedMarkerPath), { code: 'ENOENT' });
            assert.strictEqual(fixersRun, 0);
        } finally {
            output.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runFixers reports failures outside successExitCodes', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-fixer-failure-report-'));
        const filePath = path.join(tmpDir, 'test.ts');
        const scriptPath = path.join(tmpDir, 'fail-fixer.js');
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(scriptPath, 'process.exit(2);\n');

        const failures: Array<{ label: string; message: string }> = [];
        const output = {
            appendLine() {
                // no-op
            },
            reportFailure(failure: { label: string; message: string }) {
                failures.push(failure);
            },
        };
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        const fixer: RunnableFixer = {
            label: 'php-cs-fixer',
            description: 'PHP',
            detail: process.execPath,
            targetName: 'PHP',
            fixer: {
                name: 'php-cs-fixer',
                command: process.execPath,
                args: [scriptPath],
                successExitCodes: [0, 1],
            },
        };

        try {
            const fixersRun = await runFixers(filePath, output, statusBar, 'manual', [fixer]);

            assert.strictEqual(fixersRun, 0);
            assert.deepStrictEqual(failures, [
                {
                    label: 'PHP:fix:php-cs-fixer',
                    message: 'exit 2 is not in successExitCodes [0, 1]',
                },
            ]);
        } finally {
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runFixers uses configured cwd and env for fixer commands', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-fixer-cwd-'));
        const fileDir = path.join(tmpDir, 'nested');
        const filePath = path.join(fileDir, 'test.ts');
        const scriptPath = path.join(tmpDir, 'record-command-state.js');
        const fixerMarkerPath = path.join(tmpDir, 'fixer-state.json');
        await fs.mkdir(fileDir, { recursive: true });
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(
            scriptPath,
            [
                "const fs = require('node:fs');",
                'const [markerPath, envName] = process.argv.slice(2);',
                'fs.writeFileSync(markerPath, JSON.stringify({ cwd: process.cwd(), envValue: envName ? process.env[envName] ?? "" : "" }));',
                'process.exit(0);',
                '',
            ].join('\n')
        );

        const output = vscode.window.createOutputChannel('LintRunner Fixer Cwd Test');
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        const fixer: RunnableFixer = {
            label: 'cwd-fixer',
            description: 'TypeScript',
            detail: process.execPath,
            targetName: 'TypeScript',
            fixer: {
                name: 'cwd-fixer',
                command: process.execPath,
                args: [scriptPath, fixerMarkerPath, 'LINT_RUNNER_FIXER_ENV'],
                cwd: '${fileDirname}',
                env: { LINT_RUNNER_FIXER_ENV: '${fileBasenameNoExtension}' },
            },
        };

        try {
            const fixersRun = await runFixers(filePath, output, statusBar, 'manual', [fixer]);
            const fixerState = JSON.parse(await fs.readFile(fixerMarkerPath, 'utf8')) as {
                cwd: string;
                envValue: string;
            };

            assert.strictEqual(fixersRun, 1);
            await assertSamePath(fixerState.cwd, fileDir);
            assert.strictEqual(fixerState.envValue, 'test');
        } finally {
            output.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('cancelFileRun stops active fixer processes and prevents later fixers from starting', async function () {
        this.timeout(10_000);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-cancel-fixer-'));
        const filePath = path.join(tmpDir, 'test.ts');
        const slowScriptPath = path.join(tmpDir, 'slow-fixer.js');
        const quickScriptPath = path.join(tmpDir, 'quick-fixer.js');
        const startedMarkerPath = path.join(tmpDir, 'started.txt');
        const terminatedMarkerPath = path.join(tmpDir, 'terminated.txt');
        const completedMarkerPath = path.join(tmpDir, 'completed.txt');
        const secondStartedMarkerPath = path.join(tmpDir, 'second-started.txt');
        await fs.writeFile(filePath, 'const value = 1;\n');
        await fs.writeFile(
            slowScriptPath,
            [
                "const fs = require('node:fs');",
                'const [startedMarkerPath, terminatedMarkerPath, completedMarkerPath] = process.argv.slice(2);',
                "fs.writeFileSync(startedMarkerPath, 'started');",
                "process.on('SIGTERM', () => {",
                "    fs.writeFileSync(terminatedMarkerPath, 'terminated');",
                '    process.exit(0);',
                '});',
                'setTimeout(() => {',
                "    fs.writeFileSync(completedMarkerPath, 'completed');",
                '    process.exit(0);',
                `}, ${SLOW_LINTER_TIMEOUT_MS});`,
                '',
            ].join('\n')
        );
        await fs.writeFile(
            quickScriptPath,
            [
                "const fs = require('node:fs');",
                'const [secondStartedMarkerPath] = process.argv.slice(2);',
                "fs.writeFileSync(secondStartedMarkerPath, 'started');",
                'process.exit(0);',
                '',
            ].join('\n')
        );

        const output = vscode.window.createOutputChannel('LintRunner Cancel Fixer Test');
        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        const slowFixer: RunnableFixer = {
            label: 'slow-fixer',
            description: 'PHP',
            detail: process.execPath,
            targetName: 'PHP',
            fixer: {
                name: 'slow-fixer',
                command: process.execPath,
                args: [slowScriptPath, startedMarkerPath, terminatedMarkerPath, completedMarkerPath],
            },
        };
        const quickFixer: RunnableFixer = {
            label: 'quick-fixer',
            description: 'PHP',
            detail: process.execPath,
            targetName: 'PHP',
            fixer: {
                name: 'quick-fixer',
                command: process.execPath,
                args: [quickScriptPath, secondStartedMarkerPath],
            },
        };

        try {
            const runPromise = runFixers(filePath, output, statusBar, 'manual', [slowFixer, quickFixer]);
            await waitForFile(startedMarkerPath, 5_000);

            cancelFileRun(filePath);

            await Promise.race([
                runPromise,
                new Promise<never>((_, reject) => {
                    setTimeout(() => {
                        reject(new Error('Timed out waiting for cancelled fixer run to finish'));
                    }, 3_000);
                }),
            ]);

            await assertCancelledProcess(completedMarkerPath, terminatedMarkerPath);
            await assert.rejects(fs.access(secondStartedMarkerPath));
        } finally {
            cancelFileRun(filePath);
            output.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });
});
