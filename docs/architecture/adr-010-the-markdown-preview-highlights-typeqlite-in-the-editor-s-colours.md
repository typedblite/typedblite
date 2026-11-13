---
kind: adr
status: accepted
date: 2026-11-13
decision-owners: [Founder, TypeDBLite maintainers]
extends: [adr-008]
---

# ADR-010: The Markdown preview highlights TypeQLite code blocks as the editor does, in the theme's colours

- **Status:** Accepted on 2026-11-13. The founder chose to highlight code blocks in VS Code's
  Markdown preview, in the active theme's colours, and to leave GitHub plain.
- **Date:** 2026-11-13
- **Decision owners:** Founder; TypeDBLite maintainers
- **Extends:** [ADR-008](adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md).
  The client was only a launcher for the server. It now also colours the Markdown preview, from what
  the server says.

---

## Context

The docs hold 27 code blocks fenced as `typeql`. Read anywhere, they are plain text. The question
was whether they could be highlighted with the colours the editor gives the same text.

Measured on 2026-11-13, before deciding:

| Fact | Consequence |
| ---- | ----------- |
| GitHub's renderer highlights a `ts` fence, and leaves `typeql`, `typeqlite` and `tql` plain. It strips `style` attributes and `<style>` elements | **Nothing in this repository can colour a code block on GitHub.** Only a grammar in `github-linguist` could, and its colours would be GitHub's |
| The editor's colours are not the extension's. The semantic tokens are kinds (`type`, `property`, `parameter`, `variable`, `keyword`, `string`, `number`), and the TextMate grammar assigns scopes. The active theme maps both to colours | "The editor's colours" means **the active theme's**, which change when the theme does |
| VS Code has no API for a theme's token colours. An extension sees the theme's kind and its workbench colours only | The client has to read the theme's own files and apply VS Code's rules to them |
| The Markdown preview activates every extension that contributes `markdown.markdownItPlugins`, and calls the `extendMarkdownIt` it exports. Its engine sets `highlight` before plugins run, and `markdown.preview.refresh` clears its cache and re-renders. Its content security policy allows inline styles, and it does not sanitise the HTML | A plugin can replace a fence's contents with coloured spans, and ask for a re-render |
| markdown-it renders synchronously. The language server answers asynchronously | A block is drawn plain on its first render, and coloured on the re-render once the answer lands |

## Decision

**D1. The language server classifies, and the client only paints.** A new request,
`typeqlite/highlightBlocks`, takes every TypeQLite block of one Markdown document and returns, per
block, the two layers an editor draws: the TextMate scopes and the semantic tokens. The semantic
tokens come from the editor's own provider. The TextMate scopes come from the grammar file the
extension ships, run by a small tokenizer that refuses any construct it does not implement. The
client knows nothing about TypeQLite: ADR-008's rule holds.

**D2. A document's blocks are their own workspace, never the editor's.** A page's `define` block
resolves the labels in the query blocks below it. A label the page defines nowhere is not coloured as
a label, as in an editor workspace with a schema. A page with no schema colours labels by position
(ADR-008 D6). The open workspace's schema never colours a docs page.

**D3. The colours are the active theme's, resolved by VS Code's rules.** The client finds the
theme's file through the `contributes.themes` of the extension that contributes it, follows its
`include` chain, and applies the user's `editor.semanticTokenColorCustomizations` and
`editor.tokenColorCustomizations`. The rules it restates (semantic selector scoring, the fallback
from a semantic type to TextMate scopes, TextMate specificity and inheritance, and what turns
semantic highlighting on) are listed in `apps/vscode/src/markdown/theme.ts` and pinned by its
tests. A theme change or a colour setting change re-renders open previews.

**D4. When the theme cannot be read, the preview falls back to its own colours.** That covers a theme
whose token colours are in a `.tmTheme` (plist) file, and one that no installed extension
contributes. The blocks then get the preview's highlight.js classes, and the reason goes to the
TypeQLite output channel.

**D5. The fences are `typeql`, `typeqlite` and `tql`.** The docs write `typeql`, the language id is
`typeqlite`, and `tql` is the file extension.

**D6. GitHub stays plain.** A `github-linguist` grammar is **deferred**. It would bring
pattern-based highlighting only, in GitHub's colours.

## Consequences

### Positive

- A docs page previewed in VS Code shows its TypeQLite exactly as the editor would show the same
  text in a `.tql` file, in whatever theme the reader uses.
- The highlighting cannot drift from the editor's. Both layers come from the editor's own grammar file
  and semantic token provider.

### Negative / Constraints

- 🔴 **D3 reads files VS Code does not promise to keep in that shape.** If VS Code changes how themes
  are stored, or how it resolves their colours, the preview drifts from the editor without failing.
  The e2e case pins the colours of two built-in themes, to catch that on a VS Code upgrade.
- **The first render of a changed block is plain.** The coloured render follows once the server
  answers, usually within a frame or two.
- **Opening a Markdown preview starts the language server**, because the preview activates the
  extension.
- **Font styles are drawn, and nothing else.** The theme's colour, italic, bold, underline and
  strikethrough reach the preview. The preview's own code font and background stay as they are.

## References

- [ADR-008](adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md): the
  editor this extends, and D6, which the fallback in D2 follows
- `apps/vscode/src/markdown/`: the client side. `apps/vscode/src/language-server/highlight-blocks.ts`
  and `textmate.ts`: the server side
- VS Code 1.146's `markdown-language-features` and `tokenClassificationRegistry`, read from the build
  the e2e suite downloads
