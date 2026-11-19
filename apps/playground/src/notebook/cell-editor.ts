import * as monaco from 'monaco-editor/editor/editor.api.js';

import { applyTheme, prepareEnvironment, startLanguageClient } from '../editor.js';
import { LANGUAGE_ID } from '../highlighting.js';
import { currentScheme, onSchemeChange } from '../scheme.js';

/**
 * One cell's editor: Monaco with TypeQLite served by the real language server, as the playground's is, but small, with no
 * gutter, and as tall as its text.
 *
 * 🔴 **A cell's model URI is a notebook cell's** (`vscode-notebook-cell:/…#cellN`), the same shape VS Code gives one. The
 * language server keeps a notebook's cells as one schema, and a notebook's schema to itself (`schemaOwnerOf` in
 * `@typedblite/language`, ADR-012 N4), so a label defined in one cell resolves in another, in diagnostics, completion
 * and go to definition, exactly as it does in the extension. Nothing here decides what a cell can see.
 *
 * Browser only. `test-browser/notebook.test.ts` is where it is tested, in Chromium.
 */
export interface CellEditor {
  getValue(): string;
  setValue(text: string): void;
  focus(): void;
  /** The server's diagnostics for this cell: what the editor underlines. */
  markers(): { readonly message: string; readonly severity: number }[];
  dispose(): void;
}

export interface CellEditorHandlers {
  /** Ctrl or ⌘ + Enter. */
  readonly onRun: () => void;
  /** Shift + Enter: run, and move on. */
  readonly onRunAndNext: () => void;
}

const MAX_HEIGHT = 480;

export function createCellEditor(container: HTMLElement, uri: string, text: string, label: string, handlers: CellEditorHandlers): CellEditor {
  prepareEnvironment();
  startLanguageClient();
  const model = monaco.editor.createModel(text, LANGUAGE_ID, monaco.Uri.parse(uri));
  const editor = monaco.editor.create(container, {
    model,
    ariaLabel: label,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 14,
    tabSize: 2,
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    lineNumbers: 'off',
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 8,
    lineNumbersMinChars: 0,
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: { vertical: 'hidden', horizontal: 'hidden', alwaysConsumeMouseWheel: false },
    'semanticHighlighting.enabled': true,
    padding: { top: 8, bottom: 8 },
    // Suggestions and hovers may reach outside a short cell, so they are not clipped by it.
    fixedOverflowWidgets: true,
  });
  // As tall as the text, so a cell reads like a block of code and the page scrolls, not the cell.
  const fit = (): void => {
    const height = Math.min(Math.max(editor.getContentHeight(), 40), MAX_HEIGHT);
    container.style.height = `${height}px`;
    editor.layout({ width: container.clientWidth, height });
  };
  editor.onDidContentSizeChange(fit);
  fit();
  applyTheme(container, currentScheme());
  onSchemeChange((scheme) => applyTheme(container, scheme));
  editor.addAction({ id: 'typedblite.run-cell', label: 'Run cell', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => handlers.onRun() });
  editor.addAction({ id: 'typedblite.run-cell-and-next', label: 'Run cell and move on', keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter], run: () => handlers.onRunAndNext() });

  return {
    getValue: () => model.getValue(),
    setValue: (value) => model.setValue(value),
    focus: () => editor.focus(),
    markers: () => monaco.editor.getModelMarkers({ resource: model.uri }).map((marker) => ({ message: marker.message, severity: marker.severity })),
    dispose: () => {
      editor.dispose();
      model.dispose();
    },
  };
}
