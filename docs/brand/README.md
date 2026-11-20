# TypeDBLite logo

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="typedblite-logo-dark.svg">
    <img alt="TypeDBLite" src="typedblite-logo.svg" width="360">
  </picture>
</p>

The mark is a **relation**: an orange diamond joining three entities. In TypeDB's model, and so in
TypeDBLite's, a relation is a first-class thing that can join any number of role players. A thin gap
around the diamond keeps the mark light.

## Files

| File | Use it for |
| ---- | ---------- |
| [`typedblite-logo.svg`](typedblite-logo.svg) | The logo: mark and wordmark, on light backgrounds |
| [`typedblite-logo-dark.svg`](typedblite-logo-dark.svg) | The logo on dark backgrounds |
| [`typedblite-mark.svg`](typedblite-mark.svg) | The mark alone, on light backgrounds |
| [`typedblite-mark-dark.svg`](typedblite-mark-dark.svg) | The mark alone, on dark backgrounds |
| [`typedblite-icon.svg`](typedblite-icon.svg) | App icon and favicon: the mark on a dark rounded square |
| [`typedblite-icon-light.svg`](typedblite-icon-light.svg) | App icon on a light rounded square |
| [`typedblite-file-icon.svg`](typedblite-file-icon.svg), [`typedblite-file-icon-dark.svg`](typedblite-file-icon-dark.svg) | The icon for `.typeqlite` files in an editor's file tree and tabs, for light and dark themes. The mark alone, with heavier spokes and larger nodes, and no gap, so it reads at 16 px |
| [`typedblite-icon-128.png`](typedblite-icon-128.png), [`typedblite-icon-512.png`](typedblite-icon-512.png) | The app icon where SVG is not accepted. The 512 px one is the VS Code extension's icon: the build copies it into `apps/vscode/images/`, and a test checks the two match |

The logo and mark SVGs have transparent backgrounds. The wordmark is outlined, so the files render the
same everywhere without the font installed.

In a Markdown file on GitHub, pick the right logo for the reader's theme with `<picture>`:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/typedblite-logo-dark.svg">
  <img alt="TypeDBLite" src="docs/brand/typedblite-logo.svg" width="360">
</picture>
```

## Colors

| Name | Hex | Role |
| ---- | --- | ---- |
| Ink | `#15171C` | The mark and wordmark on light backgrounds; the icon's ground |
| Paper | `#F4F2EE` | The mark and wordmark on dark backgrounds |
| Signal orange | `#E8590C` | The relation diamond and "Lite", in every version |

## Typography

The wordmark is set in [Nunito](https://fonts.google.com/specimen/Nunito) (SIL Open Font License):
"TypeDB" in SemiBold (600), "Lite" in Regular (400) and signal orange, tracked at −0.02em. In the
logo files, text 64 units high sits beside a 112-unit mark with a 24-unit gap.

Headings, on the website and the playground, are set in Nunito too. Body text is set in
[Inter](https://fonts.google.com/specimen/Inter) (SIL Open Font License). It is a neutral sans that
contrasts with Nunito's rounded forms and stays readable at small sizes. Both fonts are self-hosted
(Fontsource), so no page asks a third party for them. Code stays in the reader's monospace font.

## Using the logo

- Leave clear space around the logo at least as wide as one node of the mark.
- Keep the logo at least 120 px wide. Below that, use the mark or the icon. The icon holds up at 16 px.
- Use the files as they are: don't recolor, stretch, rotate or rearrange them, or add effects.
- Don't use the logo in a way that suggests TypeDB Ltd made, sponsors or endorses TypeDBLite. It is
  an independent project (see the [README](../../README.md#special-thanks-to-typedb)). Its
  colors and shapes are deliberately unlike TypeDB's own branding.

## The mark's geometry

On a 64 × 64 grid:

- **Entities:** circles of radius 6 at (32, 14), (11.2, 50) and (52.8, 50).
- **Spokes:** lines 4 wide with round caps, from each entity to (32, 38).
- **Relation:** a 9 × 9 square rotated 45° about (32, 38).
- **Gap:** a 15 × 15 square with corner radius 3.5, rotated the same way and masked out of the
  spokes.

The icon scales the mark to 72% on a rounded square (corner radius 14) and thickens the spokes to 5,
so they survive at small sizes.
