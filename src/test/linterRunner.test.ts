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
    runFixers,
    runLinters,
    runRunnableLinters,
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

suite('Linter Runner Test Suite', () => {
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
