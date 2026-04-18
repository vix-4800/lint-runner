import * as vscode from 'vscode';
import { runLinters } from './linterRunner.js';

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner');
    const output = vscode.window.createOutputChannel('LintRunner');
    context.subscriptions.push(diagnostics, output);

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            runLinters(doc.fileName, 'onSave', diagnostics, output);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.run', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active editor.');
                return;
            }
            runLinters(editor.document.fileName, 'manual', diagnostics, output);
        })
    );
}

export function deactivate(): void {
    return;
}
