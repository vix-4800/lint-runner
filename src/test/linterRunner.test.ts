import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    cancelFileRun,
    runRunnableLinters,
    type ResolvedTargetConfig,
    type RunnableLinter,
} from '../linterRunner.js';

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
        const startedMarkerPath = path.join(tmpDir, 'started.txt');
        await fs.writeFile(filePath, 'const value = 1;\n');

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
                    '-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(startedMarkerPath)}, 'started'); setTimeout(() => {}, 10000);`,
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
        } finally {
            cancelFileRun(filePath);
            diagnostics.dispose();
            output.dispose();
            statusBar.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }

        assert.strictEqual(diagnostics.get(vscode.Uri.file(filePath))?.length ?? 0, 0);
    });
});
