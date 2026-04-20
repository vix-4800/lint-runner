import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { collectNewVisibleFileNames } from '../extension.js';

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
});
