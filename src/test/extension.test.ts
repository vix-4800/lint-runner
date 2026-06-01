import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    cleanupExtensionRuntime,
    clearAllPendingSaveDebounces,
    collectClosedFileTabUris,
    collectNewVisibleFileNames,
    collectVisibleDiffDocumentUrisByColumn,
    computeContentHash,
    createManualCodeActions,
    createManualCodeLenses,
    formatDoctorTable,
    getActionsStatusBarState,
    getManualRunNotificationTitle,
    handleClosedDocument,
    handleClosedFileUri,
    isContentChanged,
    isLoggingEnabled,
    isManualRunNotificationEnabled,
    openBundledExamples,
    OutputChannelManager,
    runDoctorWithNotification,
    runManualTaskWithNotification,
    runOnOpenPipelinesForVisibleEditors,
    type RunnablePipeline,
    type RunnableTool,
} from '../extension.js';

function createPipeline(): RunnablePipeline {
    return {
        label: 'JS: manual',
        description: 'sequence',
        detail: 'eslint',
        target: { name: 'JS' },
        pipelineName: 'manual',
        pipeline: { strategy: 'sequence', tools: ['eslint'] },
        tools: [],
    };
}

function createTool(): RunnableTool {
    return {
        label: 'eslint',
        description: 'JS / manual',
        detail: 'diagnostic: eslint ${file}',
        targetName: 'JS',
        pipelineName: 'manual',
        toolName: 'eslint',
        tool: {
            kind: 'diagnostic',
            command: 'eslint',
            args: ['${file}'],
            parser: { pattern: '(?<line>\\d+):(?<message>.+)' },
        },
    };
}

suite('Extension', () => {
    test('computeContentHash returns stable hashes', () => {
        assert.strictEqual(computeContentHash('a'), computeContentHash('a'));
        assert.notStrictEqual(computeContentHash('a'), computeContentHash('b'));
    });

    test('isContentChanged tracks per key', () => {
        const hashes = new Map<string, string>();
        assert.strictEqual(isContentChanged('a', '1', hashes), true);
        assert.strictEqual(isContentChanged('a', '1', hashes), false);
        assert.strictEqual(isContentChanged('a', '2', hashes), true);
        assert.strictEqual(isContentChanged('b', '1', hashes), true);
    });

    test('collects only new visible file documents', () => {
        const seen = new Set<string>();
        const fileUri = vscode.Uri.file('/tmp/lint-runner-visible.ts');
        const virtualUri = vscode.Uri.parse('untitled:lint-runner-visible.ts');
        const result = collectNewVisibleFileNames(
            [
                {
                    document: { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
                    viewColumn: vscode.ViewColumn.One,
                },
                {
                    document: { fileName: virtualUri.toString(), isUntitled: true, uri: virtualUri },
                    viewColumn: vscode.ViewColumn.One,
                },
            ],
            seen,
            new Map()
        );

        assert.deepStrictEqual(result, [fileUri.fsPath]);
        assert.deepStrictEqual(collectNewVisibleFileNames(
            [
                {
                    document: { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
                    viewColumn: vscode.ViewColumn.One,
                },
            ],
            seen,
            new Map()
        ), []);
    });

    test('collects seen visible file documents when includeSeen is enabled', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-seen.ts');
        const seen = new Set<string>([fileUri.toString()]);

        assert.deepStrictEqual(
            collectNewVisibleFileNames(
                [
                    {
                        document: { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
                        viewColumn: vscode.ViewColumn.One,
                    },
                ],
                seen,
                new Map(),
                { includeSeen: true }
            ),
            [fileUri.fsPath]
        );
    });

    test('collects visible diff document URIs by view column', () => {
        const original = vscode.Uri.file('/tmp/lint-runner-original.ts');
        const modified = vscode.Uri.file('/tmp/lint-runner-modified.ts');
        const regular = vscode.Uri.file('/tmp/lint-runner-regular.ts');
        const diffTab = {
            input: new vscode.TabInputTextDiff(original, modified),
        };
        const byColumn = collectVisibleDiffDocumentUrisByColumn([
            { activeTab: diffTab, viewColumn: vscode.ViewColumn.One },
            { activeTab: { input: new vscode.TabInputText(regular) }, viewColumn: vscode.ViewColumn.Two },
        ]);

        assert.deepStrictEqual(byColumn.get(vscode.ViewColumn.One), new Set([
            original.toString(),
            modified.toString(),
        ]));
        assert.strictEqual(byColumn.has(vscode.ViewColumn.Two), false);
    });

    test('skips visible diff documents without marking them seen', () => {
        const seen = new Set<string>();
        const fileUri = vscode.Uri.file('/tmp/lint-runner-diff.ts');
        const diffUrisByColumn = new Map<vscode.ViewColumn, Set<string>>([
            [vscode.ViewColumn.One, new Set([fileUri.toString()])],
        ]);

        assert.deepStrictEqual(
            collectNewVisibleFileNames(
                [
                    {
                        document: { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
                        viewColumn: vscode.ViewColumn.One,
                    },
                ],
                seen,
                diffUrisByColumn
            ),
            []
        );
        assert.strictEqual(seen.size, 0);
        assert.deepStrictEqual(
            collectNewVisibleFileNames(
                [
                    {
                        document: { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
                        viewColumn: vscode.ViewColumn.Two,
                    },
                ],
                seen,
                diffUrisByColumn
            ),
            [fileUri.fsPath]
        );
    });

    test('collects closed file tab URIs', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-closed.ts');
        const untitledUri = vscode.Uri.parse('untitled:lint-runner-closed.ts');
        const original = vscode.Uri.file('/tmp/lint-runner-original.ts');
        const modified = vscode.Uri.file('/tmp/lint-runner-modified.ts');

        assert.deepStrictEqual(
            collectClosedFileTabUris([
                { input: new vscode.TabInputText(fileUri) },
                { input: new vscode.TabInputText(untitledUri) },
                { input: new vscode.TabInputTextDiff(original, modified) },
            ]),
            [fileUri, original, modified]
        );
    });

    test('runOnOpenPipelinesForVisibleEditors reruns already seen visible files when requested', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-rerun.ts');
        const seen = new Set<string>([fileUri.toString()]);
        const runs: string[] = [];

        runOnOpenPipelinesForVisibleEditors(
            [
                {
                    document: { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
                    viewColumn: vscode.ViewColumn.One,
                },
            ],
            seen,
            { delete() { /* test stub */ }, set() { /* test stub */ } } as unknown as vscode.DiagnosticCollection,
            { appendLine() { /* test stub */ } },
            { hide() { /* test stub */ }, show() { /* test stub */ }, text: '' } as vscode.StatusBarItem,
            [],
            { includeSeen: true },
            async (fileName, trigger) => {
                runs.push(`${fileName}:${trigger}`);
                return 1;
            }
        );

        assert.deepStrictEqual(runs, [`${fileUri.fsPath}:onOpen`]);
    });

    test('formats doctor rows as markdown', () => {
        assert.strictEqual(
            formatDoctorTable([{ tool: 'eslint', found: 'yes', version: 'v1', usedBy: ['JS / manual / eslint'] }]),
            [
                '| Tool | Found | Version | Used by |',
                '| --- | --- | --- | --- |',
                '| eslint | yes | v1 | JS / manual / eslint |',
            ].join('\n')
        );
    });

    test('settings helpers read defaults and explicit false', () => {
        assert.strictEqual(isLoggingEnabled({ get: () => undefined }), true);
        assert.strictEqual(isLoggingEnabled({ get: () => false }), false);
        assert.strictEqual(isManualRunNotificationEnabled({ get: () => undefined }), true);
        assert.strictEqual(isManualRunNotificationEnabled({ get: () => false }), false);
    });

    test('manual notification title includes running tool names', () => {
        assert.strictEqual(getManualRunNotificationTitle([]), 'LintRunner: Running tools...');
        assert.strictEqual(getManualRunNotificationTitle(['eslint']), 'LintRunner: Running eslint...');
        assert.strictEqual(getManualRunNotificationTitle(['prettier', 'eslint']), 'LintRunner: Running prettier, eslint...');
    });

    test('runDoctorWithNotification shows progress while collecting tool statuses', async () => {
        const calls: string[] = [];
        const resource = vscode.Uri.file('/tmp/doctor.ts');
        const document = { uri: vscode.Uri.parse('untitled:doctor') } as vscode.TextDocument;

        await runDoctorWithNotification(resource, {
            getStatuses: async (passedResource) => {
                calls.push(`statuses:${passedResource?.toString()}`);
                return [{ tool: 'eslint', found: 'yes', version: 'v1', usedBy: ['JS / manual / eslint'] }];
            },
            withProgress: async (options, task) => {
                calls.push(`progress:${options.title}`);
                return await task({} as vscode.Progress<{ message?: string; increment?: number }>, {} as vscode.CancellationToken);
            },
            openTextDocument: async (options) => {
                const content = typeof options === 'object' && 'content' in options && options.content !== undefined
                    ? options.content
                    : '';
                calls.push(`open:${content.includes('eslint')}`);
                return document;
            },
            showTextDocument: async (shownDocument, options) => {
                const preview = typeof options === 'object' ? options.preview : undefined;
                calls.push(`show:${shownDocument === document}:${String(preview)}`);
                return {} as vscode.TextEditor;
            },
        });

        assert.deepStrictEqual(calls, [
            `progress:LintRunner: Doctor`,
            `statuses:${resource.toString()}`,
            'open:true',
            'show:true:true',
        ]);
    });

    test('openBundledExamples opens docs examples from extension dir', async () => {
        const extensionUri = vscode.Uri.file('/tmp/lint-runner-extension');
        const calls: string[] = [];
        const document = { uri: vscode.Uri.file('/tmp/lint-runner-extension/docs/examples.md') } as vscode.TextDocument;

        await openBundledExamples(extensionUri, {
            openTextDocument: (async (uri: vscode.Uri) => {
                calls.push(`open:${uri.toString()}`);
                return document;
            }) as unknown as typeof vscode.workspace.openTextDocument,
            showTextDocument: async (shownDocument, options) => {
                const preview = typeof options === 'object' ? options.preview : undefined;
                calls.push(`show:${shownDocument === document}:${String(preview)}`);
                return {} as vscode.TextEditor;
            },
        });

        assert.deepStrictEqual(calls, [
            `open:${vscode.Uri.file('/tmp/lint-runner-extension/docs/examples.md').toString()}`,
            'show:true:true',
        ]);
    });

    test('OutputChannelManager creates forwards and disposes output channel based on setting', () => {
        const calls: string[] = [];
        const createOutputChannel = ((name: string) => {
            calls.push(`create:${name}`);
            return {
                appendLine(value: string) {
                    calls.push(`append:${value}`);
                },
                dispose() {
                    calls.push('dispose');
                },
            } as unknown as vscode.OutputChannel;
        }) as typeof vscode.window.createOutputChannel;
        const manager = new OutputChannelManager(createOutputChannel);

        manager.appendLine('before');
        manager.sync(true);
        manager.appendLine('after');
        manager.sync(true);
        manager.sync(false);
        manager.appendLine('ignored');
        manager.dispose();

        assert.deepStrictEqual(calls, ['create:LintRunner', 'append:after', 'dispose']);
    });

    test('runManualTaskWithNotification skips progress when disabled', async () => {
        const result = await runManualTaskWithNotification('file.ts', ['eslint'], async () => 42, {
            isEnabled: () => false,
        });

        assert.strictEqual(result, 42);
    });

    test('runManualTaskWithNotification cancels file run on cancellation', async () => {
        const cancelled: string[] = [];
        await runManualTaskWithNotification('file.ts', ['eslint'], async () => 42, {
            onCancel: (filePath) => cancelled.push(filePath),
            withProgress: async (_options, task) => {
                const callbacks: Array<() => void> = [];
                const token = {
                    onCancellationRequested(callback: () => void) {
                        callbacks.push(callback);
                        return { dispose() { /* test stub */ } };
                    },
                } as unknown as vscode.CancellationToken;
                const promise = task({} as vscode.Progress<{ message?: string; increment?: number }>, token);
                callbacks.forEach((callback) => callback());
                return await promise;
            },
        });

        assert.deepStrictEqual(cancelled, ['file.ts']);
    });

    test('creates manual pipeline and tool code actions and lenses', () => {
        const uri = vscode.Uri.file('/tmp/file.ts');
        const pipeline = createPipeline();
        const tool = createTool();
        const actions = createManualCodeActions(uri, [pipeline], [tool]);
        const lenses = createManualCodeLenses(uri, [pipeline], [tool]);

        assert.deepStrictEqual(actions.map((action) => action.command?.command), [
            'lintRunner.runManualPipelineCodeAction',
            'lintRunner.runManualToolCodeAction',
        ]);
        assert.deepStrictEqual(lenses.map((lens) => lens.command?.command), [
            'lintRunner.runManualPipelineCodeAction',
            'lintRunner.runManualToolCodeAction',
        ]);
    });

    test('getActionsStatusBarState returns undefined without active file editor', () => {
        assert.strictEqual(getActionsStatusBarState(undefined), undefined);
    });

    test('getActionsStatusBarState returns status text and tooltip for file editors', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-status.ts');

        assert.deepStrictEqual(getActionsStatusBarState({
            document: { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
        } as Pick<vscode.TextEditor, 'document'>), {
            text: '$(wrench)',
            tooltip: `LintRunner: 0 pipeline(s), 0 tool(s) for ${vscode.workspace.asRelativePath(fileUri.fsPath)}`,
        });
    });

    test('getActionsStatusBarState returns undefined when extension is disabled', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-status-disabled.ts');

        assert.strictEqual(getActionsStatusBarState({
            document: { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
        } as Pick<vscode.TextEditor, 'document'>, () => false), undefined);
    });

    test('getActionsStatusBarState returns undefined when config validation is failing', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-status-invalid.ts');

        assert.strictEqual(getActionsStatusBarState(
            {
                document: { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
            } as Pick<vscode.TextEditor, 'document'>,
            () => true,
            () => false
        ), undefined);
    });

    test('handleClosedDocument clears seen state hashes and diagnostics', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-closed-doc.ts');
        const seen = new Set<string>([fileUri.toString()]);
        const hashes = new Map<string, string>([[fileUri.toString(), computeContentHash('const x = 1;')]]);
        const deletedUris: vscode.Uri[] = [];

        handleClosedDocument(
            { fileName: fileUri.fsPath, isUntitled: false, uri: fileUri },
            seen,
            hashes,
            { delete: (uri: vscode.Uri) => deletedUris.push(uri) } as unknown as vscode.DiagnosticCollection
        );

        assert.strictEqual(seen.has(fileUri.toString()), false);
        assert.strictEqual(hashes.has(fileUri.toString()), false);
        assert.deepStrictEqual(deletedUris, [fileUri]);
    });

    test('handleClosedFileUri clears seen state hashes and diagnostics', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-closed-uri.ts');
        const seen = new Set<string>([fileUri.toString()]);
        const hashes = new Map<string, string>([[fileUri.toString(), computeContentHash('const x = 1;')]]);
        const deletedUris: vscode.Uri[] = [];

        handleClosedFileUri(
            fileUri,
            fileUri.fsPath,
            seen,
            hashes,
            { delete: (uri: vscode.Uri) => deletedUris.push(uri) } as unknown as vscode.DiagnosticCollection
        );

        assert.strictEqual(seen.has(fileUri.toString()), false);
        assert.strictEqual(hashes.has(fileUri.toString()), false);
        assert.deepStrictEqual(deletedUris, [fileUri]);
    });

    test('clearAllPendingSaveDebounces is safe when no timers exist', () => {
        assert.doesNotThrow(() => clearAllPendingSaveDebounces());
    });

    test('cleanupExtensionRuntime clears pending state and disposes active resources', () => {
        const hashes = new Map<string, string>([['file.ts', 'hash']]);
        const seen = new Set(['file:///workspace/file.ts']);
        const calls: string[] = [];

        cleanupExtensionRuntime({
            clearPendingSaveDebounces: () => calls.push('clear-timers'),
            clearRunnerRuntimeState: () => calls.push('clear-runner'),
            savedContentHashes: hashes,
            seenOnOpenDocumentUris: seen,
            diagnostics: { clear: () => calls.push('diagnostics-clear'), dispose: () => calls.push('diagnostics-dispose') },
            runningStatusBar: { hide: () => calls.push('running-hide'), dispose: () => calls.push('running-dispose') },
            actionsStatusBar: { hide: () => calls.push('actions-hide'), dispose: () => calls.push('actions-dispose') },
            output: {
                appendLine() { /* test stub */ },
                dispose: () => calls.push('output-dispose'),
            },
            codeLensRefreshEmitter: { dispose: () => calls.push('codelens-dispose') },
        });

        assert.deepStrictEqual(calls, [
            'clear-timers',
            'clear-runner',
            'diagnostics-clear',
            'diagnostics-dispose',
            'running-hide',
            'running-dispose',
            'actions-hide',
            'actions-dispose',
            'output-dispose',
            'codelens-dispose',
        ]);
        assert.strictEqual(hashes.size, 0);
        assert.strictEqual(seen.size, 0);
    });
});
