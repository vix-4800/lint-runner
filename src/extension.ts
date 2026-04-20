import * as vscode from 'vscode';
import { runLinters } from './linterRunner.js';

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner');
    const output = vscode.window.createOutputChannel('LintRunner');
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.name = 'LintRunner';
    context.subscriptions.push(diagnostics, output, statusBar);

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            runLinters(doc.fileName, 'onSave', diagnostics, output, statusBar);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.run', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active editor.');
                return;
            }
            runLinters(editor.document.fileName, 'manual', diagnostics, output, statusBar);
        })
    );
}

export function deactivate(): void {
    return;
}
