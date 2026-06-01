import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    cancelAllFileRuns,
    cancelFileRun,
    collectDoctorToolStatuses,
    collectRunnablePipelines,
    resolveToolConfiguration,
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
    const config = vscode.workspace.getConfiguration('lintRunner');
    let previousEnabled: boolean | undefined;
    let previousRespectGitignore: boolean | undefined;

    setup(() => {
        previousEnabled = config.inspect<boolean>('enabled')?.globalValue;
        previousRespectGitignore = config.inspect<boolean>('respectGitignore')?.globalValue;
    });

    teardown(async () => {
        await config.update('enabled', previousEnabled, vscode.ConfigurationTarget.Global);
        await config.update('respectGitignore', previousRespectGitignore, vscode.ConfigurationTarget.Global);
        cancelAllFileRuns();
    });

    test('runPipeline skips all tools when extension is disabled', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-disabled-'));
        const markerPath = path.join(tmpDir, 'should-not-exist');
        const filePath = path.join(tmpDir, 'file.js');
        await fs.writeFile(filePath, 'const a = 1;');
        await config.update('enabled', false, vscode.ConfigurationTarget.Global);

        const pipeline: RunnablePipeline = {
            label: 'JS: manual',
            description: 'sequence',
            detail: 'write',
            target: { name: 'JS' },
            pipelineName: 'manual',
            pipeline: { strategy: 'sequence', tools: ['write'] },
            tools: [
                {
                    label: 'write',
                    description: 'JS / manual',
                    detail: 'write',
                    targetName: 'JS',
                    pipelineName: 'manual',
                    toolName: 'write',
                    tool: {
                        kind: 'write',
                        command: process.execPath,
                        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
                    },
                },
            ],
        };

        const statusBar = { text: '', show() { /* test stub */ }, hide() { /* test stub */ } } as vscode.StatusBarItem;
        const runCount = await runPipeline(filePath, pipeline, { appendLine() { /* test stub */ } }, statusBar);

        assert.strictEqual(runCount, 0);
        await assert.rejects(fs.access(markerPath));
    });

    test('collectRunnablePipelines matches a document language id override', () => {
        const toolConfig: ResolvedToolConfiguration = resolveToolConfiguration({
            tools: {
                eslint: {
                    kind: 'diagnostic',
                    command: 'eslint',
                    args: ['${file}'],
                    parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                },
            },
            targets: [
                {
                    name: 'TS',
                    match: { languages: ['typescript'] },
                    manual: { strategy: 'sequence', tools: ['eslint'] },
                },
            ],
        });

        const pipelines = collectRunnablePipelines(toolConfig, '/tmp/lint-runner-untitled.ts', 'manual', {
            languageId: 'typescript',
        });

        assert.deepStrictEqual(pipelines.map((pipeline) => pipeline.label), ['TS: manual']);
    });

    test('runPipeline skips files ignored by git when respectGitignore is enabled', async function () {
        this.timeout(10_000);
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-gitignore-'));
        const markerPath = path.join(tmpDir, 'should-not-exist');
        const filePath = path.join(tmpDir, 'ignored.js');
        await fs.writeFile(path.join(tmpDir, '.gitignore'), 'ignored.js\n');
        await fs.writeFile(filePath, 'const a = 1;');
        cp.execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
        await config.update('respectGitignore', true, vscode.ConfigurationTarget.Global);

        const pipeline: RunnablePipeline = {
            label: 'JS: manual',
            description: 'sequence',
            detail: 'write',
            target: { name: 'JS' },
            pipelineName: 'manual',
            pipeline: { strategy: 'sequence', tools: ['write'] },
            tools: [
                {
                    label: 'write',
                    description: 'JS / manual',
                    detail: 'write',
                    targetName: 'JS',
                    pipelineName: 'manual',
                    toolName: 'write',
                    tool: {
                        kind: 'write',
                        command: process.execPath,
                        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
                    },
                },
            ],
        };

        const statusBar = { text: '', show() { /* test stub */ }, hide() { /* test stub */ } } as vscode.StatusBarItem;
        const runCount = await runPipeline(filePath, pipeline, { appendLine() { /* test stub */ } }, statusBar);

        assert.strictEqual(runCount, 0);
        await assert.rejects(fs.access(markerPath));
    });

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

    test('runPipeline ignores exit code when successExitCodes is unset', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-exit-unset-'));
        const markerPath = path.join(tmpDir, 'marker');
        const filePath = path.join(tmpDir, 'file.js');
        await fs.writeFile(filePath, 'const a = 1;');
        const failures: Array<{ label: string; message: string }> = [];
        const pipeline: RunnablePipeline = {
            label: 'JS: manual',
            description: 'sequence',
            detail: 'unchecked, later',
            target: { name: 'JS' },
            pipelineName: 'manual',
            pipeline: { strategy: 'sequence', tools: ['unchecked', 'later'] },
            tools: [
                {
                    label: 'unchecked',
                    description: 'JS / manual',
                    detail: 'write',
                    targetName: 'JS',
                    pipelineName: 'manual',
                    toolName: 'unchecked',
                    tool: {
                        kind: 'write',
                        command: process.execPath,
                        args: ['-e', 'process.exit(7)'],
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
            {
                appendLine() { /* test stub */ },
                reportFailure: (failure) => failures.push(failure),
            },
            statusBar
        );

        assert.strictEqual(runCount, 2);
        assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'ran');
        assert.deepStrictEqual(failures, []);
    });

    test('resolveToolConfiguration leaves successExitCodes unset by default', () => {
        const resolved = resolveToolConfiguration({
            tools: {
                eslint: {
                    kind: 'diagnostic',
                    command: 'eslint',
                    args: ['${file}'],
                    parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                },
            },
        });

        assert.strictEqual(resolved.tools.eslint.successExitCodes, undefined);
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

    test('runPipeline parallel refreshes diagnostics after a successful write tool', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-parallel-refresh-'));
        const filePath = path.join(tmpDir, 'file.js');
        await fs.writeFile(filePath, 'before');
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
            label: 'JS: onSave',
            description: 'parallel',
            detail: 'write, check',
            target: { name: 'JS' },
            pipelineName: 'onSave',
            pipeline: { strategy: 'parallel', tools: ['write', 'check'] },
            tools: [
                {
                    label: 'write',
                    description: 'JS / onSave',
                    detail: 'write',
                    targetName: 'JS',
                    pipelineName: 'onSave',
                    toolName: 'write',
                    tool: {
                        kind: 'write',
                        command: process.execPath,
                        args: [
                            '-e',
                            'setTimeout(() => require("fs").writeFileSync(process.argv[1], "after"), 100)',
                            '${file}',
                        ],
                    },
                },
                {
                    label: 'check',
                    description: 'JS / onSave',
                    detail: 'diagnostic',
                    targetName: 'JS',
                    pipelineName: 'onSave',
                    toolName: 'check',
                    tool: {
                        kind: 'diagnostic',
                        command: process.execPath,
                        args: ['-e', 'process.stdout.write("1:" + require("fs").readFileSync(process.argv[1], "utf8"))', '${file}'],
                        parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
                    },
                },
            ],
        };

        const statusBar = { text: '', show() { /* test stub */ }, hide() { /* test stub */ } } as vscode.StatusBarItem;
        await runPipeline(
            filePath,
            pipeline,
            { appendLine() { /* test stub */ } },
            statusBar,
            diagnostics as unknown as vscode.DiagnosticCollection
        );

        const published = diagnostics.entries.get(vscode.Uri.file(filePath).toString()) ?? [];
        assert.strictEqual(published[0].message, 'after');
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
                'const completedMarker = process.argv[2];',
                'setTimeout(() => fs.writeFileSync(completedMarker, "done"), 5000);',
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
                    tool: { kind: 'write', command: process.execPath, args: [scriptPath, completedMarker], timeout: 10_000 },
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

});
