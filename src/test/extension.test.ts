import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
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
    getActionsStatusBarState,
    formatDoctorTable,
    getManualRunNotificationTitle,
    handleClosedFileUri,
    handleClosedDocument,
    isLoggingEnabled,
    isManualRunNotificationEnabled,
    isManualCodeActionFixer,
    isManualCodeActionLinter,
    isContentChanged,
    OutputChannelManager,
    runOnOpenLintersForVisibleEditors,
    runDoctorWithNotification,
    runManualTaskWithNotification,
    runManualFixersForEditor,
    runManualLintersForFile,

} from '../extension.js';
import {
    clearAllFileLinterDiagnostics,
    clearDiagnosticsCache,
    type ResolvedTargetConfig,
    type RunnableFixer,
    type RunnableLinter,
} from '../linterRunner.js';

const CANCELLED_TIMER_DELAY_MS = 100;
const TIMER_VERIFICATION_DELAY_MS = 15;

async function waitForCondition(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs: number = 5_000,
    intervalMs: number = 25
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error('Timed out waiting for condition');
}

function createTestTarget(name: string): ResolvedTargetConfig {
    return {
        name,
        filePatterns: [],
        languages: ['typescript'],
        preCommands: [],
        linters: [],
        fixers: [],
    };
}

function createTestRunnableLinter(name: string, targetName: string, run: 'manual' | 'onSave' | 'onOpen'): RunnableLinter {
    const target = createTestTarget(targetName);
    return {
        label: name,
        description: targetName,
        detail: `node ${name}`,
        target,
        linter: {
            name,
            command: 'node',
            args: [name],
            parser: {
                pattern: '(?<line>\\d+):(?<message>.+)',
            },
            run,
            filePatterns: [],
            languages: target.languages,
        },
    };
}

function createTestRunnableFixer(name: string, targetName: string, run?: 'manual' | 'onSave'): RunnableFixer {
    return {
        label: name,
        description: targetName,
        detail: `node ${name}`,
        targetName,
        fixer: {
            name,
            command: 'node',
            args: [name],
            run,
        },
    };
}

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('collects only new visible file documents for onOpen', () => {
        const seenDocumentUris = new Set<string>();
        const fileUri = vscode.Uri.file('/tmp/lint-runner-test.ts');
        const virtualUri = vscode.Uri.parse('untitled:lint-runner-test.ts');

        assert.deepStrictEqual(
            collectNewVisibleFileNames(
                [
                    {
                        document: {
                            fileName: fileUri.fsPath,
                            isUntitled: false,
                            uri: fileUri,
                        },
                    },
                    {
                        document: {
                            fileName: virtualUri.toString(),
                            isUntitled: true,
                            uri: virtualUri,
                        },
                    },
                ],
                seenDocumentUris
            ),
            [fileUri.fsPath]
        );

        assert.deepStrictEqual(
            collectNewVisibleFileNames(
                [
                    {
                        document: {
                            fileName: fileUri.fsPath,
                            isUntitled: false,
                            uri: fileUri,
                        },
                    },
                ],
                seenDocumentUris
            ),
            []
        );
    });

    test('formatDoctorTable aligns doctor rows into columns', () => {
        assert.strictEqual(
            formatDoctorTable([
                {
                    tool: 'phpcs',
                    found: 'yes',
                    version: '3.10.2',
                    usedBy: ['PHP'],
                },
                {
                    tool: 'mago',
                    found: 'no',
                    version: '-',
                    usedBy: ['PHP'],
                },
            ]),
            ['Tool   Found  Version  Used by', 'phpcs  yes    3.10.2   PHP', 'mago   no     -        PHP'].join(
                '\n'
            )
        );
    });

    test('collects seen visible file documents when includeSeen is enabled', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-seen.ts');
        const seenDocumentUris = new Set<string>([fileUri.toString()]);

        assert.deepStrictEqual(
            collectNewVisibleFileNames(
                [
                    {
                        document: {
                            fileName: fileUri.fsPath,
                            isUntitled: false,
                            uri: fileUri,
                        },
                    },
                ],
                seenDocumentUris,
                new Map(),
                { includeSeen: true }
            ),
            [fileUri.fsPath]
        );
    });

    test('collects visible diff document URIs by view column', () => {
        const originalUri = vscode.Uri.file('/tmp/lint-runner-original.ts');
        const modifiedUri = vscode.Uri.file('/tmp/lint-runner-modified.ts');
        const regularUri = vscode.Uri.file('/tmp/lint-runner-regular.ts');

        const diffDocumentUrisByColumn = collectVisibleDiffDocumentUrisByColumn([
            {
                activeTab: {
                    input: new vscode.TabInputTextDiff(originalUri, modifiedUri),
                },
                viewColumn: vscode.ViewColumn.One,
            },
            {
                activeTab: {
                    input: new vscode.TabInputText(regularUri),
                },
                viewColumn: vscode.ViewColumn.Two,
            },
        ]);

        assert.deepStrictEqual(diffDocumentUrisByColumn.get(vscode.ViewColumn.One), new Set([
            originalUri.toString(),
            modifiedUri.toString(),
        ]));
        assert.strictEqual(diffDocumentUrisByColumn.has(vscode.ViewColumn.Two), false);
    });

    test('skips visible diff documents without marking them seen', () => {
        const seenDocumentUris = new Set<string>();
        const fileUri = vscode.Uri.file('/tmp/lint-runner-test.ts');
        const diffDocumentUrisByColumn = new Map<vscode.ViewColumn, Set<string>>([
            [vscode.ViewColumn.One, new Set([fileUri.toString()])],
        ]);

        assert.deepStrictEqual(
            collectNewVisibleFileNames(
                [
                    {
                        document: {
                            fileName: fileUri.fsPath,
                            isUntitled: false,
                            uri: fileUri,
                        },
                        viewColumn: vscode.ViewColumn.One,
                    },
                ],
                seenDocumentUris,
                diffDocumentUrisByColumn
            ),
            []
        );
        assert.strictEqual(seenDocumentUris.size, 0);

        assert.deepStrictEqual(
            collectNewVisibleFileNames(
                [
                    {
                        document: {
                            fileName: fileUri.fsPath,
                            isUntitled: false,
                            uri: fileUri,
                        },
                        viewColumn: vscode.ViewColumn.Two,
                    },
                ],
                seenDocumentUris,
                diffDocumentUrisByColumn
            ),
            [fileUri.fsPath]
        );
    });

    test('collects closed file tab URIs', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-closed.ts');
        const untitledUri = vscode.Uri.parse('untitled:lint-runner-closed.ts');
        const diffOriginalUri = vscode.Uri.file('/tmp/lint-runner-original.ts');
        const diffModifiedUri = vscode.Uri.file('/tmp/lint-runner-modified.ts');

        assert.deepStrictEqual(
            collectClosedFileTabUris([
                { input: new vscode.TabInputText(fileUri) },
                { input: new vscode.TabInputText(untitledUri) },
                { input: new vscode.TabInputTextDiff(diffOriginalUri, diffModifiedUri) },
            ]),
            [fileUri]
        );
    });

    test('runOnOpenLintersForVisibleEditors reruns already seen visible files when requested', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-rerun.ts');
        const seenDocumentUris = new Set<string>([fileUri.toString()]);
        const runs: string[] = [];

        runOnOpenLintersForVisibleEditors(
            [
                {
                    document: {
                        fileName: fileUri.fsPath,
                        isUntitled: false,
                        uri: fileUri,
                    },
                },
            ],
            seenDocumentUris,
            {
                delete() {
                    // no-op
                },
                set() {
                    // no-op
                },
            } as unknown as vscode.DiagnosticCollection,
            {
                appendLine() {
                    // no-op
                },
            },
            {
                hide() {
                    // no-op
                },
                show() {
                    // no-op
                },
                text: '',
                tooltip: '',
                name: '',
            } as unknown as vscode.StatusBarItem,
            [],
            { includeSeen: true },
            async (fileName, trigger) => {
                runs.push(`${fileName}:${trigger}`);
            }
        );

        assert.deepStrictEqual(runs, [`${fileUri.fsPath}:onOpen`]);
    });

    test('getActionsStatusBarState returns undefined without an active file editor', () => {
        assert.strictEqual(getActionsStatusBarState(undefined), undefined);
    });

    test('getActionsStatusBarState returns status text and tooltip for file editors', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-status.ts');

        assert.deepStrictEqual(getActionsStatusBarState({
            document: {
                fileName: fileUri.fsPath,
                isUntitled: false,
                uri: fileUri,
            } as Pick<vscode.TextDocument, 'fileName' | 'isUntitled' | 'uri'>,
        } as Pick<vscode.TextEditor, 'document'>), {
            text: '$(wrench)',
            tooltip: `LintRunner: 0 linter(s), 0 fixer(s) for ${vscode.workspace.asRelativePath(fileUri.fsPath)}`,
        });
    });

    test('getActionsStatusBarState returns undefined when the extension is disabled', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-status-disabled.ts');

        assert.strictEqual(getActionsStatusBarState({
            document: {
                fileName: fileUri.fsPath,
                isUntitled: false,
                uri: fileUri,
            } as Pick<vscode.TextDocument, 'fileName' | 'isUntitled' | 'uri'>,
        } as Pick<vscode.TextEditor, 'document'>, () => false), undefined);
    });

    test('getActionsStatusBarState returns undefined when config validation is failing', () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-status-invalid.ts');

        assert.strictEqual(getActionsStatusBarState(
            {
                document: {
                    fileName: fileUri.fsPath,
                    isUntitled: false,
                    uri: fileUri,
                } as Pick<vscode.TextDocument, 'fileName' | 'isUntitled' | 'uri'>,
            } as Pick<vscode.TextEditor, 'document'>,
            () => true,
            () => false
        ), undefined);
    });

    test('isLoggingEnabled defaults to true and accepts false', () => {
        const defaultConfig: Pick<vscode.WorkspaceConfiguration, 'get'> = {
            get: () => undefined,
        };
        const disabledConfig: Pick<vscode.WorkspaceConfiguration, 'get'> = {
            get: () => false,
        };

        assert.strictEqual(isLoggingEnabled(defaultConfig), true);
        assert.strictEqual(isLoggingEnabled(disabledConfig), false);
    });

    test('isManualRunNotificationEnabled defaults to true and accepts false', () => {
        const defaultConfig: Pick<vscode.WorkspaceConfiguration, 'get'> = {
            get: () => undefined,
        };
        const disabledConfig: Pick<vscode.WorkspaceConfiguration, 'get'> = {
            get: () => false,
        };

        assert.strictEqual(isManualRunNotificationEnabled(defaultConfig), true);
        assert.strictEqual(isManualRunNotificationEnabled(disabledConfig), false);
    });

    test('getManualRunNotificationTitle includes running tool names', () => {
        assert.strictEqual(
            getManualRunNotificationTitle(['PHP:phpstan']),
            'LintRunner: Running PHP:phpstan…'
        );
        assert.strictEqual(
            getManualRunNotificationTitle(['PHP:phpstan', 'PHP:php-cs-fixer', 'JS:eslint']),
            'LintRunner: Running PHP:phpstan, PHP:php-cs-fixer, +1 more…'
        );
    });

    test('runManualTaskWithNotification shows cancellable progress and stops the file run on cancel', async () => {
        const filePath = '/tmp/lint-runner-notification.ts';
        let cancelledFilePath: string | undefined;
        let cancellationListener: (() => void) | undefined;
        let progressOptions: vscode.ProgressOptions | undefined;
        let taskRun = false;

        const result = await runManualTaskWithNotification(
            filePath,
            ['PHP:phpstan'],
            async () => {
                taskRun = true;
                cancellationListener?.();
                return 7;
            },
            {
                isEnabled: () => true,
                withProgress: async (options, task) => {
                    progressOptions = options;
                    return task(
                        { report: () => {
                            // no-op
                        } },
                        {
                            isCancellationRequested: false,
                            onCancellationRequested(listener: () => void) {
                                cancellationListener = listener;
                                return { dispose: () => {
                                    // no-op
                                } };
                            },
                        } as vscode.CancellationToken
                    );
                },
                onCancel: (currentFilePath) => {
                    cancelledFilePath = currentFilePath;
                },
            }
        );

        assert.strictEqual(result, 7);
        assert.strictEqual(taskRun, true);
        assert.strictEqual(progressOptions?.cancellable, true);
        assert.strictEqual(progressOptions?.title, 'LintRunner: Running PHP:phpstan…');
        assert.strictEqual(cancelledFilePath, filePath);
    });

    test('runManualTaskWithNotification skips progress when notifications are disabled', async () => {
        let withProgressCalled = false;

        const result = await runManualTaskWithNotification(
            '/tmp/lint-runner-notification-disabled.ts',
            ['PHP:phpstan'],
            async () => 11,
            {
                isEnabled: () => false,
                withProgress: (async () => {
                    withProgressCalled = true;
                    return 0;
                }) as typeof vscode.window.withProgress,
            }
        );

        assert.strictEqual(result, 11);
        assert.strictEqual(withProgressCalled, false);
    });

    test('runDoctorWithNotification shows progress while collecting tool statuses', async () => {
        let progressOptions: vscode.ProgressOptions | undefined;
        let collected = false;
        let openedContent: string | undefined;

        await runDoctorWithNotification(undefined, {
            getStatuses: async () => {
                collected = true;
                return [
                    {
                        tool: 'phpstan',
                        found: 'yes',
                        version: 'PHPStan 2.1.0',
                        usedBy: ['PHP:phpstan'],
                    },
                ];
            },
            withProgress: async (options, task) => {
                progressOptions = options;
                assert.strictEqual(collected, false);
                return task(
                    { report: () => {
                        // no-op
                    } },
                    {
                        isCancellationRequested: false,
                        onCancellationRequested() {
                            return { dispose: () => {
                                // no-op
                            } };
                        },
                    } as vscode.CancellationToken
                );
            },
            openTextDocument: async (options) => {
                openedContent = typeof options === 'object' && 'content' in options ? options.content : undefined;
                return {} as vscode.TextDocument;
            },
            showTextDocument: async () => ({}) as vscode.TextEditor,
            showInformationMessage: async () => undefined,
        });

        assert.strictEqual(collected, true);
        assert.strictEqual(progressOptions?.location, vscode.ProgressLocation.Notification);
        assert.strictEqual(progressOptions?.title, 'LintRunner: Checking configured tools…');
        assert.strictEqual(progressOptions?.cancellable, false);
        assert.ok(openedContent?.includes('phpstan'));
    });

    test('OutputChannelManager creates, forwards, and disposes the output channel based on setting', () => {
        const events: string[] = [];
        const disposedChannels: string[] = [];
        let createCount = 0;

        const manager = new OutputChannelManager(() => {
            createCount++;
            const channelId = `channel-${createCount}`;
            return {
                appendLine(value: string) {
                    events.push(`${channelId}:${value}`);
                },
                dispose() {
                    disposedChannels.push(channelId);
                },
            };
        });

        manager.appendLine('ignored');
        manager.sync(true);
        manager.appendLine('first');
        manager.sync(true);
        manager.appendLine('second');
        manager.sync(false);
        manager.appendLine('ignored-after-disable');
        manager.sync(true);
        manager.appendLine('third');
        manager.dispose();

        assert.deepStrictEqual(events, [
            'channel-1:first',
            'channel-1:second',
            'channel-2:third',
        ]);
        assert.deepStrictEqual(disposedChannels, ['channel-1', 'channel-2']);
    });

    test('computeContentHash returns consistent hashes for the same input', () => {
        const text = 'const x = 1;';
        assert.strictEqual(computeContentHash(text), computeContentHash(text));
    });

    test('computeContentHash returns different hashes for different content', () => {
        assert.notStrictEqual(computeContentHash('abc'), computeContentHash('def'));
        assert.notStrictEqual(computeContentHash(''), computeContentHash(' '));
    });

    test('isContentChanged returns true on first save (no previous hash)', () => {
        const hashMap = new Map<string, string>();
        const fileKey = 'file:///tmp/test.ts';
        const hash = computeContentHash('const x = 1;');

        assert.strictEqual(isContentChanged(fileKey, hash, hashMap), true);
    });

    test('isContentChanged returns false when content has not changed', () => {
        const hashMap = new Map<string, string>();
        const fileKey = 'file:///tmp/test.ts';
        const hash = computeContentHash('const x = 1;');

        isContentChanged(fileKey, hash, hashMap); // first save
        assert.strictEqual(isContentChanged(fileKey, hash, hashMap), false);
    });

    test('isContentChanged returns true when content has changed', () => {
        const hashMap = new Map<string, string>();
        const fileKey = 'file:///tmp/test.ts';
        const hash1 = computeContentHash('const x = 1;');
        const hash2 = computeContentHash('const x = 2;');

        isContentChanged(fileKey, hash1, hashMap); // first save
        assert.strictEqual(isContentChanged(fileKey, hash2, hashMap), true);
    });

    test('isContentChanged updates stored hash after each call', () => {
        const hashMap = new Map<string, string>();
        const fileKey = 'file:///tmp/test.ts';
        const hash1 = computeContentHash('version one');
        const hash2 = computeContentHash('version two');
        const hash3 = computeContentHash('version one');

        isContentChanged(fileKey, hash1, hashMap);
        isContentChanged(fileKey, hash2, hashMap);

        // Reverting to original content counts as a change
        assert.strictEqual(isContentChanged(fileKey, hash3, hashMap), true);

        // Same content again — no change
        assert.strictEqual(isContentChanged(fileKey, hash3, hashMap), false);
    });

    test('isContentChanged tracks each file key independently', () => {
        const hashMap = new Map<string, string>();
        const key1 = 'file:///tmp/file1.ts';
        const key2 = 'file:///tmp/file2.ts';
        const hash = computeContentHash('same content');

        isContentChanged(key1, hash, hashMap);
        // key2 has never been saved — must be treated as changed
        assert.strictEqual(isContentChanged(key2, hash, hashMap), true);

        // key1 unchanged
        assert.strictEqual(isContentChanged(key1, hash, hashMap), false);
    });

    test('handleClosedDocument cancels active runs and clears pending save state', async () => {
        const fileUri = vscode.Uri.file('/tmp/closed-file.ts');
        const seenDocumentUris = new Set<string>([fileUri.toString()]);
        const hashMap = new Map<string, string>([[fileUri.toString(), computeContentHash('const x = 1;')]]);
        const timers = new Map<string, ReturnType<typeof setTimeout>>();
        let timerTriggered = false;
        const timer = setTimeout(() => {
            timerTriggered = true;
        }, CANCELLED_TIMER_DELAY_MS);
        timers.set(fileUri.fsPath, timer);

        const deletedUris: vscode.Uri[] = [];
        const cancelledFiles: string[] = [];
        const clearedDiagnostics: string[] = [];

        handleClosedDocument(
            { fileName: fileUri.fsPath, uri: fileUri },
            seenDocumentUris,
            hashMap,
            { delete: (uri) => { deletedUris.push(uri); } },
            timers,
            (filePath) => { cancelledFiles.push(filePath); },
            (uriString) => { clearedDiagnostics.push(uriString); }
        );

        await new Promise((resolve) => setTimeout(resolve, TIMER_VERIFICATION_DELAY_MS));

        assert.strictEqual(timerTriggered, false);
        assert.strictEqual(timers.has(fileUri.fsPath), false);
        assert.strictEqual(seenDocumentUris.has(fileUri.toString()), false);
        assert.strictEqual(hashMap.has(fileUri.toString()), false);
        assert.deepStrictEqual(deletedUris, [fileUri]);
        assert.deepStrictEqual(cancelledFiles, [fileUri.fsPath]);
        assert.deepStrictEqual(clearedDiagnostics, [fileUri.toString()]);
    });

    test('handleClosedFileUri cancels active runs and clears pending save state', async () => {
        const fileUri = vscode.Uri.file('/tmp/closed-tab-file.ts');
        const seenDocumentUris = new Set<string>([fileUri.toString()]);
        const hashMap = new Map<string, string>([[fileUri.toString(), computeContentHash('const x = 1;')]]);
        const timers = new Map<string, ReturnType<typeof setTimeout>>();
        let timerTriggered = false;
        const timer = setTimeout(() => {
            timerTriggered = true;
        }, CANCELLED_TIMER_DELAY_MS);
        timers.set(fileUri.fsPath, timer);

        const deletedUris: vscode.Uri[] = [];
        const cancelledFiles: string[] = [];
        const clearedDiagnostics: string[] = [];

        handleClosedFileUri(
            fileUri,
            fileUri.fsPath,
            seenDocumentUris,
            hashMap,
            { delete: (uri) => { deletedUris.push(uri); } },
            timers,
            (filePath) => { cancelledFiles.push(filePath); },
            (uriString) => { clearedDiagnostics.push(uriString); }
        );

        await new Promise((resolve) => setTimeout(resolve, TIMER_VERIFICATION_DELAY_MS));

        assert.strictEqual(timerTriggered, false);
        assert.strictEqual(timers.has(fileUri.fsPath), false);
        assert.strictEqual(seenDocumentUris.has(fileUri.toString()), false);
        assert.strictEqual(hashMap.has(fileUri.toString()), false);
        assert.deepStrictEqual(deletedUris, [fileUri]);
        assert.deepStrictEqual(cancelledFiles, [fileUri.fsPath]);
        assert.deepStrictEqual(clearedDiagnostics, [fileUri.toString()]);
    });

    test('clearAllPendingSaveDebounces clears every pending timer', async () => {
        const timers = new Map<string, ReturnType<typeof setTimeout>>();
        let timerTriggered = false;

        timers.set('first', setTimeout(() => {
            timerTriggered = true;
        }, CANCELLED_TIMER_DELAY_MS));
        timers.set('second', setTimeout(() => {
            timerTriggered = true;
        }, CANCELLED_TIMER_DELAY_MS));

        clearAllPendingSaveDebounces(timers);
        await new Promise((resolve) => setTimeout(resolve, TIMER_VERIFICATION_DELAY_MS));

        assert.strictEqual(timerTriggered, false);
        assert.strictEqual(timers.size, 0);
    });

    test('cleanupExtensionRuntime clears pending state and disposes active resources', () => {
        const skipFixers = new Set(['file.ts']);
        const savedContentHashes = new Map<string, string>([['file.ts', 'hash']]);
        const seenOnOpenDocumentUris = new Set(['file:///workspace/file.ts']);
        let clearedPendingSaveDebounces = false;
        let clearedRunnerRuntimeState = false;
        let clearedDiagnostics = false;
        let disposedDiagnostics = false;
        let hidRunningStatusBar = false;
        let disposedRunningStatusBar = false;
        let hidActionsStatusBar = false;
        let disposedActionsStatusBar = false;
        let disposedOutput = false;
        let disposedCodeLensRefreshEmitter = false;

        cleanupExtensionRuntime({
            clearPendingSaveDebounces: () => {
                clearedPendingSaveDebounces = true;
            },
            clearRunnerRuntimeState: () => {
                clearedRunnerRuntimeState = true;
            },
            skipFixersOnSaveSet: skipFixers,
            savedContentHashes,
            seenOnOpenDocumentUris,
            diagnostics: {
                clear: () => {
                    clearedDiagnostics = true;
                },
                dispose: () => {
                    disposedDiagnostics = true;
                },
            },
            runningStatusBar: {
                hide: () => {
                    hidRunningStatusBar = true;
                },
                dispose: () => {
                    disposedRunningStatusBar = true;
                },
            },
            actionsStatusBar: {
                hide: () => {
                    hidActionsStatusBar = true;
                },
                dispose: () => {
                    disposedActionsStatusBar = true;
                },
            },
            output: {
                appendLine: () => undefined,
                dispose: () => {
                    disposedOutput = true;
                },
            },
            codeLensRefreshEmitter: {
                dispose: () => {
                    disposedCodeLensRefreshEmitter = true;
                },
            },
        });

        assert.strictEqual(clearedPendingSaveDebounces, true);
        assert.strictEqual(clearedRunnerRuntimeState, true);
        assert.strictEqual(skipFixers.size, 0);
        assert.strictEqual(savedContentHashes.size, 0);
        assert.strictEqual(seenOnOpenDocumentUris.size, 0);
        assert.strictEqual(clearedDiagnostics, true);
        assert.strictEqual(disposedDiagnostics, true);
        assert.strictEqual(hidRunningStatusBar, true);
        assert.strictEqual(disposedRunningStatusBar, true);
        assert.strictEqual(hidActionsStatusBar, true);
        assert.strictEqual(disposedActionsStatusBar, true);
        assert.strictEqual(disposedOutput, true);
        assert.strictEqual(disposedCodeLensRefreshEmitter, true);
    });

    test('isManualCodeActionLinter and isManualCodeActionFixer correctly identify manual runnables', () => {
        assert.strictEqual(isManualCodeActionLinter(createTestRunnableLinter('manual', 'target', 'manual')), true);
        assert.strictEqual(isManualCodeActionLinter(createTestRunnableLinter('on-save', 'target', 'onSave')), false);
        assert.strictEqual(isManualCodeActionLinter(createTestRunnableLinter('on-open', 'target', 'onOpen')), false);

        assert.strictEqual(isManualCodeActionFixer(createTestRunnableFixer('manual', 'target', 'manual')), true);
        assert.strictEqual(isManualCodeActionFixer(createTestRunnableFixer('default-manual', 'target')), true);
        assert.strictEqual(isManualCodeActionFixer(createTestRunnableFixer('on-save', 'target', 'onSave')), false);
    });

    test('createManualCodeActions creates separate actions for linters and fixers', () => {
        const uri = vscode.Uri.file('/tmp/lint-runner-actions.ts');
        const linter = createTestRunnableLinter('eslint', 'frontend', 'manual');
        const fixer = createTestRunnableFixer('prettier', 'frontend', 'manual');
        const actions = createManualCodeActions(
            uri,
            [linter],
            [fixer]
        );

        assert.strictEqual(actions.length, 2);
        assert.deepStrictEqual(actions.map((action) => action.title), [
            'Run linter: eslint (frontend)',
            'Run fixer: prettier (frontend)',
        ]);
        assert.deepStrictEqual(actions.map((action) => action.command?.command), [
            'lintRunner.runManualLinterCodeAction',
            'lintRunner.runManualFixerCodeAction',
        ]);
        assert.deepStrictEqual(actions[0].command?.arguments, [uri, linter]);
        assert.deepStrictEqual(actions[1].command?.arguments, [uri, fixer]);
    });

    test('createManualCodeLenses creates separate code lenses for linters and fixers at the file start', () => {
        const uri = vscode.Uri.file('/tmp/lint-runner-codelens.ts');
        const linter = createTestRunnableLinter('eslint', 'frontend', 'manual');
        const fixer = createTestRunnableFixer('prettier', 'frontend', 'manual');
        const codeLenses = createManualCodeLenses(
            uri,
            [linter],
            [fixer]
        );

        assert.strictEqual(codeLenses.length, 2);
        assert.deepStrictEqual(codeLenses.map((codeLens) => codeLens.command?.title), [
            'Lint: eslint (frontend)',
            'Fix: prettier (frontend)',
        ]);
        assert.deepStrictEqual(codeLenses.map((codeLens) => codeLens.command?.command), [
            'lintRunner.runManualLinterCodeAction',
            'lintRunner.runManualFixerCodeAction',
        ]);
        assert.deepStrictEqual(codeLenses[0].command?.arguments, [uri, linter]);
        assert.deepStrictEqual(codeLenses[1].command?.arguments, [uri, fixer]);
        assert.strictEqual(codeLenses[0].range.start.line, 0);
        assert.strictEqual(codeLenses[0].range.start.character, 0);
        assert.strictEqual(codeLenses[1].range.start.line, 0);
        assert.strictEqual(codeLenses[1].range.start.character, 0);
    });

    test('runManualFixersForEditor refreshes only automatic linters after manual fixers', async () => {
        const fileUri = vscode.Uri.file('/tmp/lint-runner-manual-fixer.ts');
        const fixer = createTestRunnableFixer('php-cs-fixer', 'PHP', 'manual');
        const calls: string[] = [];
        const diagnostics = {
            delete() {
                // no-op
            },
            set() {
                // no-op
            },
        } as unknown as vscode.DiagnosticCollection;
        const output = {
            appendLine() {
                // no-op
            },
        };
        const statusBar = {
            hide() {
                // no-op
            },
            show() {
                // no-op
            },
            text: '',
            tooltip: '',
            name: '',
        } as unknown as vscode.StatusBarItem;

        await runManualFixersForEditor(
            {
                document: {
                    fileName: fileUri.fsPath,
                    uri: fileUri,
                } as Pick<vscode.TextDocument, 'fileName' | 'uri'> as vscode.TextDocument,
            } as vscode.TextEditor,
            diagnostics,
            output,
            statusBar,
            [fixer],
            {
                saveDocumentBeforeManualFixers: async () => {
                    calls.push('save');
                    return true;
                },
                runWithManualNotification: async (filePath, labels, task) => {
                    calls.push(`notify:${filePath}:${labels.join(',')}`);
                    return task();
                },
                runFixers: async (filePath, _output, _statusBar, trigger, selectedFixers) => {
                    calls.push(`fix:${filePath}:${trigger}:${selectedFixers.map((item) => item.label).join(',')}`);
                    return selectedFixers.length;
                },
                runLinters: async (filePath, trigger) => {
                    calls.push(`lint:${filePath}:${trigger}`);
                },
                showWarningMessage: async (message) => {
                    calls.push(`warn:${message}`);
                    return undefined;
                },
            }
        );

        assert.deepStrictEqual(calls, [
            'save',
            `notify:${fileUri.fsPath}:PHP:fix:php-cs-fixer`,
            `fix:${fileUri.fsPath}:manual:php-cs-fixer`,
            `lint:${fileUri.fsPath}:onSave`,
        ]);
    });

    test('runManualFixersForEditor shows a warning when a fixer fails', async () => {
        const fileUri = vscode.Uri.file('/tmp/manual-fixer-failure.ts');
        const calls: string[] = [];
        const fixer = createTestRunnableFixer('php-cs-fixer', 'PHP', 'manual');
        const diagnostics = {
            clear() {
                // no-op
            },
            delete() {
                // no-op
            },
            dispose() {
                // no-op
            },
            set() {
                // no-op
            },
        } as unknown as vscode.DiagnosticCollection;
        const output = {
            appendLine() {
                // no-op
            },
        };
        const statusBar = {
            hide() {
                // no-op
            },
            show() {
                // no-op
            },
            text: '',
            tooltip: '',
            name: '',
        } as unknown as vscode.StatusBarItem;

        await runManualFixersForEditor(
            {
                document: {
                    fileName: fileUri.fsPath,
                    uri: fileUri,
                } as Pick<vscode.TextDocument, 'fileName' | 'uri'> as vscode.TextDocument,
            } as vscode.TextEditor,
            diagnostics,
            output,
            statusBar,
            [fixer],
            {
                saveDocumentBeforeManualFixers: async () => true,
                runWithManualNotification: async (_filePath, _labels, task) => task(),
                runFixers: async (_filePath, runOutput) => {
                    runOutput.reportFailure?.({
                        label: 'PHP:fix:php-cs-fixer',
                        message: 'exit 2 is not in successExitCodes [0, 1]',
                    });
                    return 0;
                },
                runLinters: async () => {
                    calls.push('lint');
                },
                showWarningMessage: async (message) => {
                    calls.push(`warn:${message}`);
                    return undefined;
                },
            }
        );

        assert.deepStrictEqual(calls, [
            'warn:LintRunner: PHP:fix:php-cs-fixer failed: exit 2 is not in successExitCodes [0, 1]',
            'lint',
        ]);
    });

    test('runManualLintersForFile shows a warning when a linter fails', async () => {
        const fileUri = vscode.Uri.file('/tmp/manual-linter-failure.ts');
        const calls: string[] = [];
        const diagnostics = {
            clear() {
                // no-op
            },
            delete() {
                // no-op
            },
            dispose() {
                // no-op
            },
            set() {
                // no-op
            },
        } as unknown as vscode.DiagnosticCollection;
        const output = {
            appendLine() {
                // no-op
            },
        };
        const statusBar = {
            hide() {
                // no-op
            },
            show() {
                // no-op
            },
            text: '',
            tooltip: '',
            name: '',
        } as unknown as vscode.StatusBarItem;

        await runManualLintersForFile(
            fileUri.fsPath,
            diagnostics,
            output,
            statusBar,
            [createTestRunnableLinter('phpstan', 'PHP', 'manual')],
            {
                runWithManualNotification: async (_filePath, labels, task) => {
                    calls.push(`notify:${labels.join(',')}`);
                    return task();
                },
                runRunnableLinters: async (_filePath, _diagnostics, runOutput) => {
                    runOutput.reportFailure?.({
                        label: 'PHP:phpstan',
                        message: 'spawn ENOENT',
                    });
                    return 1;
                },
                showWarningMessage: async (message) => {
                    calls.push(`warn:${message}`);
                    return undefined;
                },
            }
        );

        assert.deepStrictEqual(calls, [
            'notify:PHP:phpstan',
            'warn:LintRunner: PHP:phpstan failed: spawn ENOENT',
        ]);
    });

    test('config changes clear diagnostics from removed targets before the next publish', async function () {
        this.timeout(15_000);

        const extension = vscode.extensions.getExtension('vix.lint-runner');
        assert.ok(extension);
        await extension.activate();

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-runner-config-change-'));
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

        const config = vscode.workspace.getConfiguration('lintRunner');
        const previousTargets = config.inspect<unknown[]>('targets')?.globalValue;
        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document);
        const uri = document.uri;

        try {
            clearAllFileLinterDiagnostics();
            clearDiagnosticsCache();
            await vscode.commands.executeCommand('lintRunner.clearDiagnostics');

            await config.update(
                'targets',
                [
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
                                run: 'manual',
                            },
                        ],
                    },
                ],
                vscode.ConfigurationTarget.Global
            );

            await waitForCondition(() => vscode.languages.getDiagnostics(uri).length === 0);
            await vscode.commands.executeCommand('lintRunner.run');
            assert.deepStrictEqual(
                vscode.languages.getDiagnostics(uri).map((diagnostic) => diagnostic.message),
                ['backend issue']
            );

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
                                run: 'manual',
                            },
                        ],
                    },
                ],
                vscode.ConfigurationTarget.Global
            );

            await waitForCondition(() => vscode.languages.getDiagnostics(uri).length === 0);
            await vscode.commands.executeCommand('lintRunner.run');
            assert.deepStrictEqual(
                vscode.languages.getDiagnostics(uri).map((diagnostic) => diagnostic.message),
                ['frontend issue']
            );
        } finally {
            clearAllFileLinterDiagnostics();
            clearDiagnosticsCache();
            await vscode.commands.executeCommand('lintRunner.clearDiagnostics');
            await config.update('targets', previousTargets, vscode.ConfigurationTarget.Global);
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });
});
