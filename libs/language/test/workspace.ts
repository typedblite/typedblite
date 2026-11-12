import { URI, type FileSystemNode, type FileSystemProvider, type LangiumDocument } from 'langium';
import { createTypeQLiteServices } from '../src/typeqlite-module.js';
import type { TypeQLiteFile } from '../src/generated/ast.js';

type Diagnostic = NonNullable<LangiumDocument['diagnostics']>[number];

export const uriOf = (name: string) => URI.parse(`file:///workspace/${name}`);

/**
 * The files on "disk". `DocumentBuilder.update` asks the file system whether a changed URI is a file,
 * and re-reads it, as the language server does when the editor reports a file changed on disk. So a
 * workspace that changes needs one to answer.
 */
class MemoryFileSystem implements FileSystemProvider {
  readonly files = new Map<string, string>();
  private node(uri: URI): FileSystemNode {
    const isFile = this.files.has(uri.toString());
    return { uri, isFile, isDirectory: !isFile };
  }
  async stat(uri: URI) { return this.node(uri); }
  statSync(uri: URI) { return this.node(uri); }
  async exists(uri: URI) { return this.files.has(uri.toString()); }
  existsSync(uri: URI) { return this.files.has(uri.toString()); }
  async readBinary(uri: URI) { return new TextEncoder().encode(this.readFileSync(uri)); }
  readBinarySync(uri: URI) { return new TextEncoder().encode(this.readFileSync(uri)); }
  async readFile(uri: URI) { return this.readFileSync(uri); }
  readFileSync(uri: URI): string {
    const text = this.files.get(uri.toString());
    if (text === undefined) throw new Error(`No file ${uri.toString()}.`);
    return text;
  }
  async readDirectory() { return []; }
  readDirectorySync() { return []; }
}

/**
 * A workspace of several TypeQLite documents, built together the way the language server builds an
 * editor's workspace (ADR-008 D3).
 *
 * Each call gets its own services, so no case can see another case's documents. `parseHelper` adds
 * every document it parses to one shared workspace, which is exactly the leak a cross-file spec
 * cannot afford.
 */
export async function workspace(files: Record<string, string>) {
  const disk = new MemoryFileSystem();
  const services = createTypeQLiteServices({ fileSystemProvider: () => disk });
  const { LangiumDocuments, DocumentBuilder } = services.shared.workspace;
  const documents: LangiumDocument[] = [];
  for (const [name, text] of Object.entries(files)) {
    disk.files.set(uriOf(name).toString(), text);
    documents.push(await LangiumDocuments.getOrCreateDocument(uriOf(name)));
  }
  await DocumentBuilder.build(documents, { validation: true });

  const documentOf = (name: string) => {
    const document = LangiumDocuments.getDocument(uriOf(name));
    if (!document) throw new Error(`No document ${name} in this workspace.`);
    return document as LangiumDocument<TypeQLiteFile>;
  };

  /**
   * The position just inside the `occurrence`th match of `needle` in a document, so that a request
   * lands on that word rather than on the boundary before it.
   */
  const positionOf = (name: string, needle: string, occurrence = 0) => {
    const document = documentOf(name);
    const text = document.textDocument.getText();
    let offset = -1;
    for (let i = 0; i <= occurrence; i += 1) {
      offset = text.indexOf(needle, offset + 1);
      if (offset < 0) throw new Error(`'${needle}' occurs fewer than ${occurrence + 1} times in ${name}.`);
    }
    return document.textDocument.positionAt(offset + 1);
  };

  /** The text document identifier and a position, as every LSP request carries them. */
  const at = (name: string, needle: string, occurrence = 0) => ({
    textDocument: { uri: uriOf(name).toString() },
    position: positionOf(name, needle, occurrence),
  });

  return {
    services,
    documentOf,
    positionOf,
    at,
    diagnostics: (name: string): Diagnostic[] => documentOf(name).diagnostics ?? [],
    messages: (name: string): string[] =>
      (documentOf(name).diagnostics ?? []).map((d) =>
        typeof d.message === 'string' ? d.message : d.message.value,
      ),
    /** Delete documents from the workspace, as a file deleted on disk is, and rebuild what is affected. */
    remove: async (...names: string[]) => {
      for (const name of names) disk.files.delete(uriOf(name).toString());
      await DocumentBuilder.update([], names.map(uriOf));
    },
    /** Add or replace a document, and rebuild what is affected. */
    put: async (name: string, text: string) => {
      disk.files.set(uriOf(name).toString(), text);
      await DocumentBuilder.update([uriOf(name)], []);
    },
  };
}
