import { Cancellation, DocumentState, URI, isOperationCancelled } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, it } from 'vitest';
import { createTypeQLiteServices } from '../src/typeqlite-module.js';

/**
 * A validated document's diagnostics reach the editor even when a newer update cancels the build.
 *
 * Langium 4.4 marks a document `Validated` and complete, then calls the `Validated` listeners (the
 * language server sends the diagnostics from one), checking the cancellation token before each. An
 * editor that opens several files at once cancels the build in flight with every `didOpen`, so a cancel
 * can land in that gap. The listener is skipped, and nothing rebuilds the document afterwards: its
 * diagnostics were never sent (`TypeQLiteDocumentBuilder.notifyDocumentPhase`).
 *
 * The race is a matter of timing in the server (about three runs in ten for five rapid `didOpen`s).
 * This spec cancels at exactly that point, so it fails every time without the fix.
 */
describe('diagnostics are published from a cancelled build', () => {
  it('runs the Validated listener for a document that was validated before the cancel', async () => {
    const { shared, TypeQLite } = createTypeQLiteServices({ ...NodeFileSystem });
    const { LangiumDocumentFactory, LangiumDocuments, DocumentBuilder } = shared.workspace;
    const uri = URI.parse('file:///workspace/invalid.typeqlite');
    const document = LangiumDocumentFactory.fromString(
      'define attribute name, value string; entity person, owns name, owns name @key;',
      uri,
    );
    LangiumDocuments.addDocument(document);

    const published: string[] = [];
    DocumentBuilder.onDocumentPhase(DocumentState.Validated, (validated) => {
      published.push(validated.uri.toString());
    });

    // Cancel the build the moment this document has been validated: after its diagnostics exist and
    // before the Validated listeners run, which is where a second `didOpen` lands in the editor.
    const source = new Cancellation.CancellationTokenSource();
    const validator = TypeQLite.validation.DocumentValidator;
    const validate = validator.validateDocument.bind(validator);
    validator.validateDocument = async (...args) => {
      const diagnostics = await validate(...args);
      source.cancel();
      return diagnostics;
    };

    await DocumentBuilder.build([document], { validation: true }, source.token).catch((error) => {
      if (!isOperationCancelled(error)) throw error;
    });

    // The precondition that makes a missed publish permanent: validated, with diagnostics held.
    expect(document.state).toBe(DocumentState.Validated);
    expect(document.diagnostics?.length).toBeGreaterThan(0);
    expect(published).toEqual([uri.toString()]);
  });
});
