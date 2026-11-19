import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** Polls until `done`, for things the editor finishes on its own schedule. */
async function waitFor(done: () => boolean, what: string, timeout = 30_000): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    // The copy under test is the one the runner chose: the installed `.vsix` under `nx e2e`.
    assert.equal(extension.extensionPath, process.env['TYPEQLITE_E2E_EXTENSION']);
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
    // `entity project, owns project-id, owns nope-id;`: project-id at 21, nope-id at 38.
    assert.equal(on(21)?.type, 'property');
    assert.equal(on(38), undefined);
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
    // The declaration, the `owns` in another schema file, and `has nav-name` in a query (a label,
    // found since Phase 04, ADR-008 D5). Other fixtures may use it too, so every hit must be a real use.
    for (const expected of ['nav-shared.typeqlite', 'nav-people.typeqlite', 'labels.tql']) {
      assert.ok(files.includes(expected), `references include ${expected}`);
    }
    for (const location of found ?? []) {
      const text = (await vscode.workspace.openTextDocument(location.uri)).getText(location.range);
      assert.equal(text, 'nav-name');
    }
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

  async 'completion offers the workspace’s definitions of the kind each position expects'() {
    const document = await open('complete.tql');
    await diagnosticsSettled(document.uri);
    const offered = async (needle: string) => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        document.positionAt(document.getText().indexOf(needle)),
      );
      return (list?.items ?? []).map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    };
    const afterIsa = await offered('nav-person');
    assert.ok(afterIsa.includes('nav-person') && afterIsa.includes('nav-employment'), 'after isa: types');
    const afterHas = await offered('nav-name');
    assert.ok(afterHas.includes('nav-name'), 'after has: attributes');
    assert.ok(!afterHas.includes('nav-person'), 'after has: not entities');
    const asRole = await offered('nav-employee');
    assert.ok(asRole.includes('nav-employee'), 'a role player: the relation’s roles');
  },

  async 'a quick fix offers the nearest defined label for an unknown one'() {
    const document = await open('labels.tql');
    const [warning] = await settledOn(document.uri, 1);
    assert.ok(warning);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      document.uri,
      warning.range,
    );
    assert.ok(
      (actions ?? []).some((action) => action.title === "Change to 'nav-person'"),
      `offered: ${(actions ?? []).map((action) => action.title).join(', ')}`,
    );
  },

  async 'rename from a schema renames the query labels too'() {
    const schema = await open('rename-schema.typeqlite');
    await diagnosticsSettled(schema.uri);
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider',
      schema.uri,
      schema.positionAt(schema.getText().indexOf('ren-thing') + 1),
      'ren-object',
    );
    assert.ok(edit, 'a workspace edit');
    const files = edit.entries().map(([uri]) => uri.fsPath.split('/').pop()).sort();
    assert.deepEqual(files, ['rename-query.tql', 'rename-schema.typeqlite']);
    assert.ok(await vscode.workspace.applyEdit(edit));
    const query = await vscode.workspace.openTextDocument(uriOf('rename-query.tql'));
    assert.equal(query.getText(), 'match\n$x isa ren-object;\n');
  },

  async 'semantic tokens colour a resolved query label and not an unknown one'() {
    const document = await open('labels.tql');
    await settledOn(document.uri, 1);
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
      'vscode.provideDocumentSemanticTokensLegend',
      document.uri,
    );
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
      'vscode.provideDocumentSemanticTokens',
      document.uri,
    );
    assert.ok(legend && tokens);
    const byText = new Map<string, string>();
    let line = 0;
    let character = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
      line += tokens.data[i]!;
      character = tokens.data[i] === 0 ? character + tokens.data[i + 1]! : tokens.data[i + 1]!;
      const start = new vscode.Position(line, character);
      const text = document.getText(new vscode.Range(start, start.translate(0, tokens.data[i + 2]!)));
      byText.set(text, legend.tokenTypes[tokens.data[i + 3]!]!);
    }
    // The workspace has a schema, so a label is coloured only when it resolves (ADR-008 D6).
    assert.equal(byText.get('nav-person'), 'type');
    assert.equal(byText.get('nav-name'), 'property');
    assert.equal(byText.has('nav-persn'), false);
  },

  async 'the Theme Bridge reads the active theme where VS Code keeps it, for a remote window (ADR-010 D7)'() {
    // In this local window both extensions share a host, so the preview never needs the bridge. This
    // drives the command the main extension sends from a remote host, and checks what comes back.
    const bridge = vscode.extensions.getExtension('typedblite.typeqlite-theme');
    assert.ok(bridge, 'the Theme Bridge is installed');
    assert.deepEqual(bridge.packageJSON.extensionKind, ['ui']);
    type Result = { files?: unknown[]; missing?: string };
    const dark = await vscode.commands.executeCommand<Result>('typeqlite.themeFiles', 'Dark 2026');
    assert.ok(dark?.files, `the bridge read Dark 2026: ${JSON.stringify(dark)}`);
    assert.equal(dark.files.length, 4, 'Dark 2026 → Dark Modern → Dark+ → Dark (Visual Studio), base first');
    assert.ok(bridge.isActive, 'the command activated the bridge');
    const unknown = await vscode.commands.executeCommand<Result>('typeqlite.themeFiles', 'No Such Theme');
    assert.match(unknown?.missing ?? '', /No Such Theme/);
  },

  async "the TextMate grammar scopes keywords by kind, in a .tql file and in a Markdown editor's fences"() {
    // Outside the workspace, so the fixtures join no other case's schema. The command reads a file
    // and tokenizes it with VS Code's own TextMate engine (Oniguruma), every injection included.
    const dir = mkdtempSync(join(tmpdir(), 'typeqlite-scopes-'));
    const schema = 'define entity person, owns name @key; attribute name, value string;';
    writeFileSync(join(dir, 'scopes.tql'), `${schema}\n`);
    writeFileSync(join(dir, 'scopes.md'), ['# Scopes', '', '```typeql', schema, '```', '', 'entity', ''].join('\n'));
    const scopesOf = async (name: string) => {
      const tokens = await vscode.commands.executeCommand<{ c: string; t: string }[]>(
        '_workbench.captureSyntaxTokens',
        vscode.Uri.file(join(dir, name)),
      );
      return tokens.map((token) => ({ text: token.c.trim(), scopes: token.t.split(' ') }));
    };
    const expected: [string, string][] = [
      ['define', 'keyword.control.typeqlite'],
      ['entity', 'storage.type.typeqlite'],
      ['owns', 'keyword.control.typeqlite'],
      ['@key', 'keyword.annotations.typeqlite'],
      ['string', 'storage.modifier.typeqlite'],
    ];
    for (const file of ['scopes.tql', 'scopes.md']) {
      const tokens = await scopesOf(file);
      for (const [text, scope] of expected) {
        const token = tokens.find((t) => t.text === text);
        assert.ok(token && token.scopes.includes(scope), `${file}: '${text}' has ${token?.scopes.join(' ')}, not ${scope}`);
        if (file === 'scopes.md') assert.ok(token.scopes.includes('meta.embedded.block.typeqlite'), `${text} is inside the fence`);
      }
    }
    // Outside the fence, `entity` is Markdown text.
    const prose = (await scopesOf('scopes.md')).filter((t) => t.text === 'entity').at(-1)!;
    assert.ok(!prose.scopes.some((s) => s.endsWith('.typeqlite')), `prose 'entity' has ${prose.scopes.join(' ')}`);
  },

  async 'the Markdown preview colours TypeQLite code blocks in the theme, and again when it changes (ADR-010)'() {
    const markdown = [
      '```typeql',
      'define',
      'attribute name, value string;',
      'entity person, owns name;',
      '```',
      '',
      '```typeql',
      'match $p isa person, has name "Ann";',
      '```',
      '',
    ].join('\n');
    /** The query block's runs, as `text colour`, once the preview draws them in `expected`'s colour. */
    const queryRuns = async (expected: string) => {
      const started = Date.now();
      let html = '';
      while (Date.now() - started < 20_000) {
        // The preview's own engine, with every markdown-it plugin an extension contributes.
        html = await vscode.commands.executeCommand<string>('markdown.api.render', markdown);
        const query = html.split('<code').at(-1)!;
        if (query.toLowerCase().includes(`color:${expected}`)) {
          return [...query.matchAll(/<span style="color:(#[0-9a-f]+)">([^<]*)<\/span>/gi)].map(
            ([, colour, text]) => `${text} ${colour!.toLowerCase()}`,
          );
        }
        await new Promise((done) => setTimeout(done, 200));
      }
      throw new Error(`The preview never drew the query in ${expected}:\n${html}`);
    };
    // Each colour below was read from the theme's files, its includes followed, by hand.
    // VS Code 1.146's default theme, Dark 2026 → Dark Modern → Dark+ → Dark (Visual Studio).
    assert.deepEqual(await queryRuns('#c586c0'), [
      'match #c586c0', // keyword.control: Dark+ (longer than Dark 2026's `keyword`)
      '$p #c9d1d9', // variable → variable.other.readwrite: Dark 2026's `variable.other`
      'isa #c586c0',
      'person #4ec9b0', // type → entity.name.type: Dark+, resolved against the other block
      'has #c586c0',
      'name #c9d1d9', // property → variable.other.property: Dark 2026's `variable.other`
      '&quot;Ann&quot; #a5d6ff', // string: Dark 2026's, later than Dark (Visual Studio)'s
    ]);
    const workbench = vscode.workspace.getConfiguration('workbench');
    await workbench.update('colorTheme', 'Light Modern', vscode.ConfigurationTarget.Global);
    try {
      // Light Modern → Light+ → Light (Visual Studio).
      assert.deepEqual(await queryRuns('#af00db'), [
        'match #af00db',
        '$p #001080',
        'isa #af00db',
        'person #267f99',
        'has #af00db',
        'name #001080',
        '&quot;Ann&quot; #a31515',
      ]);
    } finally {
      await workbench.update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
    }
  },

  async 'the engine host starts over the sidecar from the installed extension, and a session works through it'() {
    const extension = vscode.extensions.getExtension<{ host: { call<T>(operation: string, input?: Record<string, unknown>): Promise<T> } }>('typedblite.typeqlite');
    assert.ok(extension, 'the extension is installed');
    const api = await extension.activate();
    // The host is the bundle inside the installed `.vsix`, run by the `node` on PATH: nothing of the repository.
    assert.ok(extension.extensionPath.includes('extensions'), 'the installed copy, not the source folder');

    // Through the command other extensions use: the envelope, as the host sent it.
    const envelope = await vscode.commands.executeCommand<{ status: string; data: { id: string; hasSchema: boolean } }>('typedblite.host.request', 'session.open', {
      schema: 'define attribute name, value string; entity person, owns name;',
    });
    assert.equal(envelope.status, 'success');
    assert.equal(envelope.data.hasSchema, true);

    // Through the exported API, in the same host process, so the session is still there.
    const session = envelope.data.id;
    await api.host.call('session.run', { session, statement: 'insert $p isa person, has name "Ada";' });
    const read = await api.host.call<{ kind: string; rows: { n: string }[] }>('session.run', {
      session,
      statement: 'match $p isa person, has name $n; select $n;',
    });
    assert.deepEqual(read.rows, [{ n: 'Ada' }]);

    // A fault is the host's own code, not a crash.
    await assert.rejects(api.host.call('session.get', { session: 's404' }), (error: { code?: string }) => error.code === 'SESSION_NOT_FOUND');
    await api.host.call('session.close', { session });
  },

  async 'a .tql.md file opens as a notebook: Markdown cells and TypeQLite cells, and no outputs'() {
    const notebook = await vscode.workspace.openNotebookDocument(uriOf('reading.tql.md'));
    assert.equal(notebook.notebookType, 'typeqlite-notebook');
    assert.deepEqual(
      notebook.getCells().map((cell) => [cell.kind, cell.document.languageId]),
      [
        [vscode.NotebookCellKind.Markup, 'markdown'],
        [vscode.NotebookCellKind.Code, 'typeqlite'],
        [vscode.NotebookCellKind.Markup, 'markdown'],
        [vscode.NotebookCellKind.Code, 'typeqlite'],
        [vscode.NotebookCellKind.Code, 'typeqlite'],
      ],
    );
    assert.equal(notebook.cellAt(1).document.getText(), 'define\nattribute title, value string;\nentity book, owns title;');
    assert.ok(notebook.getCells().every((cell) => cell.outputs.length === 0), 'a notebook has no outputs when it is opened');
    assert.equal(notebook.isDirty, false);
  },

  async 'saving a notebook after editing one cell changes only that cell, and writes no output'() {
    const notebook = await vscode.workspace.openNotebookDocument(uriOf('reading.tql.md'));
    const before = readFileSync(join(WORKSPACE, 'reading.tql.md'), 'utf8');
    const cell = notebook.cellAt(3);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), 'insert $b isa book, has title "Emma";');
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(notebook.isDirty);
    assert.ok(await notebook.save());
    const after = readFileSync(join(WORKSPACE, 'reading.tql.md'), 'utf8');
    assert.equal(after, before.replace('insert $b isa book, has title "Dune";', 'insert $b isa book, has title "Emma";'));
  },

  async 'a Markdown file is a notebook only when it is opened as one'() {
    // `vscode.open` opens a file as a user's click does, with the editor that is the default for it.
    await vscode.commands.executeCommand('vscode.open', uriOf('plain.md'));
    const plain = vscode.window.activeTextEditor?.document;
    assert.ok(plain, 'a plain .md file opens in the text editor');
    assert.equal(plain.languageId, 'markdown');
    assert.ok(!vscode.workspace.notebookDocuments.some((n) => n.uri.fsPath === plain.uri.fsPath), 'opening a .md file does not make it a notebook');
    await vscode.commands.executeCommand('vscode.openWith', plain.uri, 'typeqlite-notebook-markdown');
    const notebook = vscode.workspace.notebookDocuments.find((n) => n.uri.fsPath === plain.uri.fsPath);
    assert.ok(notebook, 'Open With the notebook type opens it as one');
    assert.equal(notebook.notebookType, 'typeqlite-notebook-markdown');
    assert.deepEqual(
      notebook.getCells().map((cell) => cell.kind),
      [vscode.NotebookCellKind.Markup, vscode.NotebookCellKind.Code],
    );
  },

  async 'Run All runs the cells through the engine host: outputs, a refusal on its cell, and nothing marked changed'() {
    const notebook = await vscode.workspace.openNotebookDocument(uriOf('run.tql.md'));
    await vscode.window.showNotebookDocument(notebook);
    await vscode.commands.executeCommand('notebook.execute');
    // Cells 1 to 4 run; cell 4 is refused, so cell 5 is never started.
    await waitFor(() => notebook.cellAt(4).executionSummary?.success !== undefined, 'the refused cell to finish');

    const text = (cell: vscode.NotebookCell, mime: string): string[] =>
      cell.outputs.flatMap((output) => output.items.filter((item) => item.mime === mime).map((item) => new TextDecoder().decode(item.data)));
    assert.equal(notebook.cellAt(1).executionSummary?.success, true);
    assert.deepEqual(text(notebook.cellAt(1), 'text/plain'), ['Schema applied.']);
    assert.ok(text(notebook.cellAt(2), 'text/markdown')[0]!.includes('entity'), 'an insert answers what it made');
    assert.ok(text(notebook.cellAt(3), 'text/markdown')[0]!.includes('Dune'), 'a later cell sees what an earlier cell inserted');

    assert.equal(notebook.cellAt(4).executionSummary?.success, false);
    const refusal = JSON.parse(text(notebook.cellAt(4), 'application/vnd.code.notebook.error')[0]!) as { name: string; message: string };
    assert.equal(refusal.name, 'TypeQLite refused this statement');
    assert.match(refusal.message, /nonexistent-type.*line 1, column/);
    assert.equal(notebook.cellAt(5).executionSummary?.success, undefined, 'the cell after the refusal was not run');
    assert.equal(notebook.cellAt(5).outputs.length, 0);

    // Feature invariant 4: running a notebook does not change the file, so it is not dirty.
    assert.equal(notebook.isDirty, false);
  },

  async 'restart empties the notebook\'s store, and a cell that needs the schema is then refused'() {
    const notebook = await vscode.workspace.openNotebookDocument(uriOf('run.tql.md'));
    await vscode.window.showNotebookDocument(notebook);
    await vscode.commands.executeCommand('typedblite.notebook.restart');
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 3, end: 4 }], document: notebook.uri });
    await waitFor(() => notebook.cellAt(3).executionSummary?.success === false, 'the query on the empty store to be refused');
    const output = notebook.cellAt(3).outputs[0]!.items.find((item) => item.mime === 'application/vnd.code.notebook.error')!;
    const refusal = JSON.parse(new TextDecoder().decode(output.data)) as { name: string; message: string };
    assert.equal(refusal.name, 'No schema yet');
    assert.match(refusal.message, /no schema has been applied/);
  },

  async 'a label defined in one cell resolves in another: diagnostics, definition and completion'() {
    const notebook = await vscode.workspace.openNotebookDocument(uriOf('scope-a.tql.md'));
    await vscode.window.showNotebookDocument(notebook);
    // Cell 0 is the heading; the three code cells follow it with only blank lines between them.
    const [schema, entity, query] = [notebook.cellAt(1), notebook.cellAt(2), notebook.cellAt(3)];

    // `title` resolved into the cell before; only `missing`, which no cell defines, is refused.
    const problems = await settledOn(entity!.document.uri, 1);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /'missing'/);
    assert.equal(vscode.languages.getDiagnostics(schema!.document.uri).length, 0);

    const at = entity!.document.positionAt(entity!.document.getText().indexOf('title, owns') + 1);
    const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', entity!.document.uri, at);
    const target = (found[0] as vscode.LocationLink).targetUri ?? (found[0] as vscode.Location).uri;
    assert.equal(target.toString(), schema!.document.uri.toString(), 'go to definition crosses cells');

    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', query!.document.uri, query!.document.positionAt(query!.document.getText().indexOf('bo') + 2));
    const labels = list.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    assert.ok(labels.includes('book'), 'completion offers a definition from another cell');
  },

  async 'a notebook\'s schema is its own: another notebook does not see it, nor does a file'() {
    const other = await vscode.workspace.openNotebookDocument(uriOf('scope-b.tql.md'));
    await vscode.window.showNotebookDocument(other);
    const problems = await settledOn(other.cellAt(1).document.uri, 1);
    assert.match(problems[0]!.message, /'title'/, '`title` is notebook A\'s, so notebook B cannot name it');
  },

  async 'a notebook uses a file store only when told to, and a write is permanent only in the mode chosen'() {
    const notebook = await vscode.workspace.openNotebookDocument(uriOf('store.tql.md'));
    await vscode.window.showNotebookDocument(notebook);
    const store = join(WORKSPACE, 'books.db');
    const readerSees = async () => {
      const envelope = await vscode.commands.executeCommand<{ data: { kind: string; reason?: string; rows?: { t: string }[] } }>('typedblite.host.request', 'session.run', {
        location: store,
        statement: 'match $b isa book, has title $t; select $t;',
      });
      return envelope.data;
    };

    // Nothing opens a file by itself: the notebook runs in memory until a store is chosen.
    await vscode.commands.executeCommand('typedblite.notebook.openStore', undefined, { kind: 'file', location: store, mode: 'manual' });
    await vscode.commands.executeCommand('notebook.execute');
    await waitFor(() => notebook.cellAt(2).executionSummary?.success !== undefined, 'the cells to run');
    assert.equal(notebook.cellAt(2).executionSummary?.success, true);

    // Held, not committed: another connection to the file sees nothing, not even the schema.
    const held = await readerSees();
    assert.equal(held.kind, 'refused');
    assert.equal(held.reason, 'no-schema');

    await vscode.commands.executeCommand('typedblite.notebook.commit');
    assert.deepEqual((await readerSees()).rows, [{ t: 'Dune' }], 'a commit makes it permanent');

    // The choice is not in the notebook, and choosing it did not change it.
    assert.equal(notebook.isDirty, false);
    assert.ok(!readFileSync(join(WORKSPACE, 'store.tql.md'), 'utf8').includes('books.db'), 'the path is never written into the notebook');

    await vscode.commands.executeCommand('typedblite.notebook.openStore', undefined, { kind: 'memory' });
  },

  async 'a notebook is exported as a script of its code cells, and as Markdown'() {
    const notebook = await vscode.workspace.openNotebookDocument(uriOf('reading.tql.md'));
    await vscode.window.showNotebookDocument(notebook);
    const script = vscode.Uri.file(join(WORKSPACE, 'exported.tql'));
    const markdown = vscode.Uri.file(join(WORKSPACE, 'exported.md'));
    await vscode.commands.executeCommand('typedblite.notebook.exportScript', undefined, script);
    await vscode.commands.executeCommand('typedblite.notebook.exportMarkdown', undefined, markdown);

    const code = notebook.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code).map((c) => c.document.getText());
    assert.equal(readFileSync(script.fsPath, 'utf8'), `${code.join('\n\n')}\n`);
    const text = readFileSync(markdown.fsPath, 'utf8');
    assert.ok(text.startsWith('# Reading list'));
    assert.equal((text.match(/```typeql/g) ?? []).length, code.length);
  },

  async 'the reading list guide runs as a notebook, to its deliberate refusal'() {
    const notebook = await vscode.workspace.openNotebookDocument(uriOf('reading-list.tql.md'));
    await vscode.window.showNotebookDocument(notebook);
    const code = notebook.getCells().filter((cell) => cell.kind === vscode.NotebookCellKind.Code);
    assert.equal(code.length, 9);
    await vscode.commands.executeCommand('notebook.execute');
    await waitFor(() => code[8]!.executionSummary?.success !== undefined, 'the last cell to finish');

    // Every cell before the last runs to completion; the last is refused, on purpose, with the engine's own message.
    assert.deepEqual(code.slice(0, 8).map((cell) => cell.executionSummary?.success), Array(8).fill(true));
    assert.equal(code[8]!.executionSummary?.success, false);
    const refusal = JSON.parse(new TextDecoder().decode(code[8]!.outputs[0]!.items.find((i) => i.mime === 'application/vnd.code.notebook.error')!.data)) as { name: string };
    assert.equal(refusal.name, 'TypeQLite refused this statement');

    // The list, after adding Piranesi and finishing Dune: the tour's answer.
    const table = new TextDecoder().decode(code[5]!.outputs[0]!.items.find((i) => i.mime === 'text/markdown')!.data);
    assert.ok(table.includes('Dune') && table.includes('Piranesi') && table.includes('done') && table.includes('to\\-read'));
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
