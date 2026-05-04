import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
    collectNewVisibleFileNames,
    collectVisibleDiffDocumentUrisByColumn,
    computeContentHash,
    handleClosedDocument,
    isContentChanged,
} from '../extension.js';

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
        }, 10);
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

        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.strictEqual(timerTriggered, false);
        assert.strictEqual(timers.has(fileUri.fsPath), false);
        assert.strictEqual(seenDocumentUris.has(fileUri.toString()), false);
        assert.strictEqual(hashMap.has(fileUri.toString()), false);
        assert.deepStrictEqual(deletedUris, [fileUri]);
        assert.deepStrictEqual(cancelledFiles, [fileUri.fsPath]);
        assert.deepStrictEqual(clearedDiagnostics, [fileUri.toString()]);
    });
});
