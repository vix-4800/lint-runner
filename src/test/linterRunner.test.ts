import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    cancelAllFileRuns,
    cancelFileRun,
    runFixers,
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
            await fs.access(terminatedMarkerPath);
            await assert.rejects(fs.access(completedMarkerPath));
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
                fs.access(firstTerminatedMarkerPath),
                fs.access(secondTerminatedMarkerPath),
            ]);
            await assert.rejects(fs.access(firstCompletedMarkerPath));
            await assert.rejects(fs.access(secondCompletedMarkerPath));
        } finally {
            cancelAllFileRuns();
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
            assert.strictEqual(statusBar.tooltip, 'Running linters: PHP:fix:php-cs-fixer');
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
});
