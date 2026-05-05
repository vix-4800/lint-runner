import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
    collectClosedFileTabUris,
    collectNewVisibleFileNames,
    collectVisibleDiffDocumentUrisByColumn,
    computeContentHash,
    createManualCodeActions,
    handleClosedFileUri,
    handleClosedDocument,
    isManualCodeActionFixer,
    isManualCodeActionLinter,
    isContentChanged,
} from '../extension.js';
import type { ResolvedTargetConfig, RunnableFixer, RunnableLinter } from '../linterRunner.js';

const CANCELLED_TIMER_DELAY_MS = 100;
const TIMER_VERIFICATION_DELAY_MS = 15;

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

    test('manual code action filters keep only manual linters and fixers', () => {
        assert.strictEqual(isManualCodeActionLinter(createTestRunnableLinter('manual', 'target', 'manual')), true);
        assert.strictEqual(isManualCodeActionLinter(createTestRunnableLinter('on-save', 'target', 'onSave')), false);
        assert.strictEqual(isManualCodeActionLinter(createTestRunnableLinter('on-open', 'target', 'onOpen')), false);

        assert.strictEqual(isManualCodeActionFixer(createTestRunnableFixer('manual', 'target', 'manual')), true);
        assert.strictEqual(isManualCodeActionFixer(createTestRunnableFixer('default-manual', 'target')), true);
        assert.strictEqual(isManualCodeActionFixer(createTestRunnableFixer('on-save', 'target', 'onSave')), false);
    });

    test('createManualCodeActions creates separate actions for linters and fixers', () => {
        const uri = vscode.Uri.file('/tmp/lint-runner-actions.ts');
        const actions = createManualCodeActions(
            uri,
            [createTestRunnableLinter('eslint', 'frontend', 'manual')],
            [createTestRunnableFixer('prettier', 'frontend', 'manual')]
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
        assert.deepStrictEqual(actions[0].command?.arguments, [
            uri,
            createTestRunnableLinter('eslint', 'frontend', 'manual'),
        ]);
    });
});
