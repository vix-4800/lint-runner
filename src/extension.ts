import * as vscode from 'vscode';
import { runFixers, runLinters } from './linterRunner.js';

let untrustedWorkspaceWarningShown = false;

function canRunWorkspaceCommands(showRepeatedWarning: boolean): boolean {
    if (vscode.workspace.isTrusted) {
        return true;
    }

    if (showRepeatedWarning || !untrustedWorkspaceWarningShown) {
        vscode.window.showWarningMessage(
            'LintRunner: Workspace is not trusted. Trust the workspace to run configured commands.'
        );
        untrustedWorkspaceWarningShown = true;
    }

    return false;
}

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection('lintRunner');
    const output = vscode.window.createOutputChannel('LintRunner');
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.name = 'LintRunner';
    context.subscriptions.push(diagnostics, output, statusBar);

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (!canRunWorkspaceCommands(false)) {
                return;
            }
            runLinters(doc.fileName, 'onOpen', diagnostics, output, statusBar);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (!canRunWorkspaceCommands(false)) {
                return;
            }
            runLinters(doc.fileName, 'onSave', diagnostics, output, statusBar);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            diagnostics.delete(doc.uri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.run', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active editor.');
                return;
            }
            if (!canRunWorkspaceCommands(true)) {
                return;
            }
            runLinters(editor.document.fileName, 'manual', diagnostics, output, statusBar);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lintRunner.fix', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor === undefined) {
                vscode.window.showWarningMessage('LintRunner: No active editor.');
                return;
            }
            if (!canRunWorkspaceCommands(true)) {
                return;
            }

            const saved = await editor.document.save();
            if (!saved) {
                vscode.window.showWarningMessage('LintRunner: File was not saved.');
                return;
            }

            const fixersRun = await runFixers(editor.document.fileName, output, statusBar);
            if (fixersRun === 0) {
                vscode.window.showWarningMessage('LintRunner: No matching fix command.');
                return;
            }

            runLinters(editor.document.fileName, 'manual', diagnostics, output, statusBar);
        })
    );
}

export function deactivate(): void {
    return;
}
