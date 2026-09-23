/**
 * HTML email to plain text.
 *
 * Lives here, not in the Apps Script, because the parsers are written against
 * a particular shape of text and that shape has to be reproducible in a test.
 * Apps Script's own `getPlainBody()` is a black box whose output cannot be
 * checked against a fixture — and charges went missing for days because of
 * exactly that.
 *
 * The rule: one table row, one line. Bank notifications are label/value
 * tables, and every parser reads them per line. Source HTML is usually
 * pretty-printed, so the newlines sitting between `</td>` and the next `<td>`
 * will split a row in half unless they are deliberately collapsed. Only real
 * block boundaries may end a line.
 */

/** Stands in for a line break while all other whitespace is collapsed. */
const BREAK = '\u0000';

export function htmlToText(html) {
  return String(html || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

    // Real breaks, marked so they survive the whitespace collapse below.
    .replace(/<br\s*\/?>/gi, BREAK)
    .replace(/<\/(p|div|tr|table|h[1-6]|li|blockquote)>/gi, BREAK)

    // Cells are separated, not broken: the label and its value belong on the
    // same line. `normalize()` in the parsers flattens the pipe away.
    .replace(/<\/(td|th)>/gi, ' | ')

    .replace(/<[^>]+>/g, ' ')

    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    // Decode the rest by number rather than from a list. Promerica's spacer
    // cells are &#8202; (hair space); left undecoded they appear as literal
    // "&#8202;" in the text and in every error sample.
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => codePoint(parseInt(n, 16)))

    // Everything that is not a marked break collapses, including the source's
    // own newlines between tags. This is what keeps a row on one line.
    .replace(/\s+/g, ' ')

    .split(BREAK)
    .map((line) => line.replace(/\s*\|\s*$/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    // Stripping a tag leaves whitespace before punctuation: "</strong>,"
    // becomes " ,". Bank sentences are read by their punctuation.
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .trim();
}

/**
 * Entity code point to text. Anything in the space-separator family becomes
 * an ordinary space, so field patterns can rely on [ \t] meaning "a gap".
 */
function codePoint(n) {
  if (!Number.isFinite(n) || n < 9 || n > 0x10ffff) return ' ';
  const ch = String.fromCodePoint(n);
  return /[\s  -   　]/.test(ch) ? ' ' : ch;
}
