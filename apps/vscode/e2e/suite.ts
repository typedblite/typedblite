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

/** Diagnostics settle on a count: every build may republish, so the first set seen is not the answer. */
async function settledOn(uri: vscode.Uri, count: number, timeout = 20_000): Promise<vscode.Diagnostic[]> {
  const started = Date.now();
  for (;;) {
    const found = vscode.languages.getDiagnostics(uri);
    if (found.length === count || Date.now() - started > timeout) return found;
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** A document is built once the server has published for it, even an empty set. */
async function diagnosticsSettled(uri: vscode.Uri, quiet = 500): Promise<void> {
  // An empty publication is indistinguishable from none, so wait for the server to go quiet.
  let last = JSON.stringify(vscode.languages.getDiagnostics(uri));
  let stableSince = Date.now();
  const started = Date.now();
  while (Date.now() - stableSince < quiet && Date.now() - started < 10_000) {
    await new Promise((done) => setTimeout(done, 100));
    const now = JSON.stringify(vscode.languages.getDiagnostics(uri));
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    }
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

  async 'go to definition crosses files'() {
    const document = await open('nav-people.typeqlite');
    await diagnosticsSettled(document.uri);
    const at = document.positionAt(document.getText().indexOf('nav-name') + 1);
    const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      document.uri,
      at,
    );
    const target = found?.[0];
    const uri = target && ('targetUri' in target ? target.targetUri : target.uri);
    assert.equal(uri?.fsPath, uriOf('nav-shared.typeqlite').fsPath);
  },

  async 'find references crosses files'() {
    const document = await open('nav-shared.typeqlite');
    const at = document.positionAt(document.getText().indexOf('nav-name') + 1);
    const found = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      document.uri,
      at,
    );
    const files = (found ?? []).map((l) => l.uri.fsPath.split('/').pop()).sort();
    // `labels.tql` holds `has nav-name`: a label, found since Phase 04 (ADR-008 D5).
    assert.deepEqual(files, ['labels.tql', 'nav-people.typeqlite', 'nav-shared.typeqlite']);
  },

  async 'the outline lists definitions, roles and re-opens'() {
    const shared = await open('nav-shared.typeqlite');
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      shared.uri,
    );
    assert.deepEqual(
      symbols?.map((s) => [s.name, s.kind]),
      [
        ['nav-name', vscode.SymbolKind.Property],
        ['nav-employment', vscode.SymbolKind.Interface],
      ],
    );
    assert.deepEqual(symbols?.[1]?.children.map((c) => c.name), ['nav-employee']);
    const reopens = await open('nav-reopens.typeqlite');
    const reopened = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      reopens.uri,
    );
    assert.deepEqual(reopened?.map((s) => s.name), ['nav-employment']);
  },

  async 'hover shows the definition and its documentation'() {
    const document = await open('nav-people.typeqlite');
    const at = document.positionAt(document.getText().indexOf('nav-person') + 1);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      at,
    );
    const text = (hovers ?? [])
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : c.value))
      .join('\n');
    assert.match(text, /entity nav-person/);
    assert.match(text, /Someone the organisation knows about\./);
    assert.match(text, /A human being/);
  },

  async 'a multi-line definition folds'() {
    const document = await open('nav-people.typeqlite');
    const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      document.uri,
    );
    assert.ok((ranges ?? []).some((r) => r.start === 2), 'the entity on line 3 folds');
  },

  async 'a query label goes to its definition in the schema file'() {
    const document = await open('labels.tql');
    const at = document.positionAt(document.getText().indexOf('nav-person') + 1);
    const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      document.uri,
      at,
    );
    const target = found?.[0];
    const uri = target && ('targetUri' in target ? target.targetUri : target.uri);
    assert.equal(uri?.fsPath, uriOf('nav-people.typeqlite').fsPath);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      at,
    );
    const text = (hovers ?? []).flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
    assert.match(text, /entity nav-person/);
  },

  async 'an unknown query label is a warning, not an error (ADR-008 D6)'() {
    const document = await open('labels.tql');
    const [warning, ...rest] = await settledOn(document.uri, 1);
    assert.deepEqual(rest, []);
    assert.ok(warning);
    assert.equal(codeOf(warning), 'typedblite.unknown-label');
    assert.equal(warning.severity, vscode.DiagnosticSeverity.Warning);
    assert.equal(document.getText(warning.range), 'nav-persn');
  },

  // Last, because it deletes a file from the workspace.
  async 'a schema split across files resolves, and deleting the defining file unresolves it'() {
    // `split-attributes.typeqlite` is never opened: the server found it by indexing the workspace.
    const document = await open('split-people.typeqlite');
    const before = await settledOn(document.uri, 1);
    assert.deepEqual(
      before.map((d) => d.message),
      ["Could not resolve reference to AttributeDef named 'missing-attr'."],
      '`employee-name` resolved into the other file (ADR-008 D3)',
    );
    await vscode.workspace.fs.delete(uriOf('split-attributes.typeqlite'));
    const after = await settledOn(document.uri, 2);
    assert.deepEqual(after.map((d) => d.message).sort(), [
      "Could not resolve reference to AttributeDef named 'employee-name'.",
      "Could not resolve reference to AttributeDef named 'missing-attr'.",
    ]);
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
