import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
    collectNewVisibleFileNames,
    collectVisibleDiffDocumentUrisByColumn,
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
});
