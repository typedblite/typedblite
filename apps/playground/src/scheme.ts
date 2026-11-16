/**
 * Whether the page is light or dark, and when that changes. A host page that sets `data-theme` on the
 * `<html>` element (Starlight does: `light` or `dark`, whatever the reader chose or the system says) is
 * obeyed; without one, the browser's `prefers-color-scheme` decides, as it does on the standalone page.
 */
export type Scheme = 'light' | 'dark';

const query = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)');

export function currentScheme(): Scheme {
  const set = document.documentElement.dataset['theme'];
  if (set === 'light' || set === 'dark') return set;
  return query().matches ? 'dark' : 'light';
}

/** Calls `listener` with the new scheme when the host page or the system changes it. */
export function onSchemeChange(listener: (scheme: Scheme) => void): void {
  query().addEventListener('change', () => listener(currentScheme()));
  new MutationObserver(() => listener(currentScheme())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/**
 * The colour a custom property has on `element`, as `#rrggbb`, or `undefined` if the browser does not
 * give an sRGB value. The property may be built from others (`var(--sl-color-gray-6)`) and in any CSS
 * colour syntax, so a probe element resolves it.
 */
export function resolveColour(element: HTMLElement, property: string): string | undefined {
  const probe = document.createElement('span');
  probe.style.color = `var(${property})`;
  probe.hidden = true;
  element.append(probe);
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  if (!rgb) return undefined;
  return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
}
