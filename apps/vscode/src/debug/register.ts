import * as vscode from 'vscode';

import { TypeQLiteDebugSession, type Files, type HostCaller } from '@typedblite/debugger';

import { DEBUG_TYPE } from './constants.js';

/** The files a launch reads, through VS Code, so a workspace on any file system is read as the editor reads it. */
export const workspaceFiles: Files = {
  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path)));
  },
};

/**
 * What F5 starts when there is no `launch.json`, or a configuration leaves something out: the TypeQLite file in the
 * active editor, stopping on entry, its schema and seed paths relative to the workspace folder.
 */
export class TypeQLiteDebugConfigurations implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, configuration: vscode.DebugConfiguration): vscode.DebugConfiguration | undefined {
    if (!configuration.type && !configuration.request && !configuration.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId !== 'typeqlite') {
        void vscode.window.showInformationMessage('Open a TypeQLite file (.tql or .typeqlite) to debug it.');
        return undefined;
      }
      return { type: DEBUG_TYPE, request: 'launch', name: 'Debug TypeQLite file', program: editor.document.uri.fsPath, cwd: folder?.uri.fsPath, stopOnEntry: true };
    }
    if (!configuration.program) {
      void vscode.window.showInformationMessage('A TypeQLite launch configuration names its program.');
      return undefined;
    }
    return configuration;
  }
}

/**
 * The TypeQLite debugger (ADR-014). The adapter runs inline, in the extension's own process (B3), and reaches the
 * engine through the extension's `HostClient`: every statement it runs is run by the engine host, in a `:memory:`
 * session, through `session.debug` (B2). The extension never imports the engine.
 */
export function registerDebugger(context: vscode.ExtensionContext, host: HostCaller): void {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new TypeQLiteDebugConfigurations()),
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new TypeQLiteDebugSession(host, workspaceFiles)),
    }),
  );
}
