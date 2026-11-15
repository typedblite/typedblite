/// <reference lib="webworker" />
/**
 * The language server, in its own Web Worker: LSP over the worker's message port, which is the transport
 * Monaco's LSP client (`createTransportToWorker`) speaks. A separate worker from the one that runs
 * programs, so a long run never freezes the editor's feedback and ending a run never ends the server.
 */
import './polyfills.js';
import { BrowserMessageReader, BrowserMessageWriter, createConnection } from 'vscode-languageserver/browser';
import { serve } from './language-server.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
serve(createConnection(new BrowserMessageReader(scope), new BrowserMessageWriter(scope)));
