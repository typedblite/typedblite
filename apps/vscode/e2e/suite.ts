import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';

/**
 * The cases, run inside a real VS Code's extension host. They assert through the `vscode.execute*`
 * and `vscode.provide*` commands, which go through the client, the IPC transport and the server:
 * the whole path a user's editor takes (ADR-008 D7).
 */
const WORKSPACE = process.env['TYPEQLITE_E2E_WORKSPACE']!;
const uriOf = (name: string) => vscode.Uri.file(join(WORKSPACE, name));

async function open(name: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(uriOf(name));
  await vscode.window.showTextDocument(document);
  return document;
}

/** Diagnostics arrive asynchronously, after the server has built the document. */
async function diagnosticsOf(uri: vscode.Uri, timeout = 20_000): Promise<vscode.Diagnostic[]> {
  const started = Date.now();
  for (;;) {
    const found = vscode.languages.getDiagnostics(uri);
    if (found.length > 0) return found;
    if (Date.now() - started > timeout) return found;
    await new Promise((done) => setTimeout(done, 100));
  }
}

const codeOf = (diagnostic: vscode.Diagnostic) =>
  typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;

const FORMATTING: vscode.FormattingOptions = { tabSize: 2, insertSpaces: true };

const cases: Record<string, () => Promise<void>> = {
  async 'the extension activates on a TypeQLite document'() {
    const document = await open('valid.tql');
    assert.equal(document.languageId, 'typeqlite', '.tql is claimed (ADR-008 D4)');
    const extension = vscode.extensions.getExtension('typedblite.typeqlite');
    assert.ok(extension, 'the extension is installed under its ADR-008 D1 id');
    await extension.activate();
    assert.ok(extension.isActive);
  },

  async 'a validator diagnostic reaches the editor, with its code'() {
    const document = await open('invalid.typeqlite');
    const [problem, ...rest] = await diagnosticsOf(document.uri);
    assert.ok(problem, 'a diagnostic was published');
    assert.deepEqual(rest, []);
    assert.equal(codeOf(problem), 'typedblite.duplicate-owns');
    assert.equal(problem.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(problem.range.start.line, 2);
    assert.equal(problem.range.start.character, 31);
  },

  async 'Format Document formats, and formatting the result changes nothing'() {
    const document = await open('messy.typeqlite');
    const before = document.getText();
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      document.uri,
      FORMATTING,
    );
    assert.ok(edits && edits.length > 0, 'the formatter proposed edits');
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, edits);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.notEqual(document.getText(), before);
    const again = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      document.uri,
      FORMATTING,
    );
    assert.deepEqual(again ?? [], [], 'formatting is idempotent');
  },

  async 'semantic tokens colour a resolved reference and not an unresolved one'() {
    const document = await open('resolution.typeqlite');
    // Wait for the build: the tokens of an unbuilt document are not the ones under test.
    await diagnosticsOf(document.uri);
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
      'vscode.provideDocumentSemanticTokensLegend',
      document.uri,
    );
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
      'vscode.provideDocumentSemanticTokens',
      document.uri,
    );
    assert.ok(legend && tokens, 'the server provides semantic tokens');
    const decoded: { line: number; character: number; type: string }[] = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
      line += tokens.data[i]!;
      character = tokens.data[i] === 0 ? character + tokens.data[i + 1]! : tokens.data[i + 1]!;
      decoded.push({ line, character, type: legend.tokenTypes[tokens.data[i + 3]!]! });
    }
    const on = (at: number) => decoded.find((t) => t.line === 2 && t.character === at);
    // `entity skill, owns skill-id, owns nope-id;`: skill-id at 19, nope-id at 34.
    assert.equal(on(19)?.type, 'property');
    assert.equal(on(34), undefined);
  },
};

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const [name, test] of Object.entries(cases)) {
    try {
      await test();
      console.log(`  ✔ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`  ✘ ${name}\n${error instanceof Error ? error.stack : String(error)}`);
    }
  }
  console.log(`\n${Object.keys(cases).length - failures.length} passed, ${failures.length} failed`);
  if (failures.length > 0) throw new Error(`${failures.length} e2e case(s) failed: ${failures.join('; ')}`);
}
