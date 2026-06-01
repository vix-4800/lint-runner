import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    cancelAllFileRuns,
    cancelFileRun,
    collectDoctorToolStatuses,
    runPipeline,
    type ResolvedToolConfiguration,
    type RunnablePipeline,
} from '../toolRunner.js';

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

suite('Tool Pipeline Runner', () => {
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
            target: { name: 'JS' },
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
        assert.strictEqual(published[0].source, 'eslint');
        assert.strictEqual(published[0].code, 'rule-id');
    });

    test('cancelFileRun stops active tool process', async function () {
        this.timeout(10_000);
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-cancel-'));
        const filePath = path.join(tmpDir, 'file.js');
        const completedMarker = path.join(tmpDir, 'completed');
        const scriptPath = path.join(tmpDir, 'slow.js');
        await fs.writeFile(filePath, 'const a = 1;');
        await fs.writeFile(
            scriptPath,
            [
                'const fs = require("fs");',
                `setTimeout(() => fs.writeFileSync(${JSON.stringify(completedMarker)}, "done"), 5000);`,
            ].join('\n')
        );
        const pipeline: RunnablePipeline = {
            label: 'JS: manual',
            description: 'sequence',
            detail: 'slow',
            target: { name: 'JS' },
            pipelineName: 'manual',
            pipeline: { strategy: 'sequence', tools: ['slow'] },
            tools: [
                {
                    label: 'slow',
                    description: 'JS / manual',
                    detail: 'write',
                    targetName: 'JS',
                    pipelineName: 'manual',
                    toolName: 'slow',
                    tool: { kind: 'write', command: process.execPath, args: [scriptPath], timeout: 10_000 },
                },
            ],
        };

        const statusBar = { text: '', show() { /* test stub */ }, hide() { /* test stub */ } } as vscode.StatusBarItem;
        const runPromise = runPipeline(filePath, pipeline, { appendLine() { /* test stub */ } }, statusBar);
        await new Promise((resolve) => setTimeout(resolve, 100));
        cancelFileRun(filePath);
        await runPromise;
        await assert.rejects(waitForFile(completedMarker, 500));
    });

    test('collectDoctorToolStatuses groups commands by pipeline use', async () => {
        const config: ResolvedToolConfiguration = {
            vars: {},
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
                    manual: { strategy: 'sequence', tools: ['eslint'] },
                    onSave: { strategy: 'sequence', tools: ['prettier', 'eslint'] },
                },
            ],
        };

        const statuses = await collectDoctorToolStatuses(config, {
            checkCommand: (command) => command === 'eslint',
            detectVersion: async (command) => `${command} 1.0.0`,
        });

        assert.deepStrictEqual(statuses, [
            {
                tool: 'eslint',
                found: 'yes',
                version: 'eslint 1.0.0',
                usedBy: ['JS / manual / eslint', 'JS / onSave / eslint'],
            },
            {
                tool: 'prettier',
                found: 'no',
                version: '-',
                usedBy: ['JS / onSave / prettier'],
            },
        ]);
    });

    teardown(() => {
        cancelAllFileRuns();
    });
});
