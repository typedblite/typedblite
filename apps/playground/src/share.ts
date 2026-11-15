/**
 * A program in a URL: `#code=<base64url of the UTF-8 text>`.
 *
 * No server holds it. The whole program is in the link, so a shared link reproduces the run exactly,
 * and the page never sends the code anywhere.
 */
const KEY = 'code=';
/** A link past this is refused on the way in: nothing here is a program anyone wrote by hand. */
const MAX_DECODED_BYTES = 256 * 1024;
/** Past this many characters, some chat and mail tools cut a link short. The page says so. */
export const LONG_LINK = 8_000;

export function encodeShare(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  // In chunks: spreading a large array into `fromCharCode` overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `#${KEY}${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}

/** The program a hash holds, or `undefined` when it holds none, or something that is not one. */
export function decodeShare(hash: string): string | undefined {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!body.startsWith(KEY)) return undefined;
  const encoded = body.slice(KEY.length);
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length > (MAX_DECODED_BYTES * 4) / 3 + 4) return undefined;
  try {
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    // `fatal`: a link that is not valid UTF-8 is refused, not shown with replacement characters.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
