/**
 * HTML email to plain text.
 *
 * Lives here, not in the Apps Script, because the parsers are written against
 * a particular shape of text and that shape has to be reproducible in a test.
 * Apps Script's own `getPlainBody()` is a black box whose output we cannot
 * check against a fixture — and a Davivienda charge went missing for days
 * because of exactly that.
 */
export function htmlToText(html) {
  return String(html || '')
    // Mail is CRLF. A stray \r left in the middle of a line is invisible in a
    // log and breaks any pattern anchored with [ \t].
    .replace(/\r\n?/g, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    // Block boundaries become whitespace. Without this, the end of one
    // element runs into the start of the next and a sentence split across
    // two <p> tags — which is how Davivienda writes its notifications —
    // reads as one word.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li|blockquote)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    // Decode the rest by number rather than keeping a list. Promerica's
    // spacer cells are &#8202; (hair space); left undecoded they turn into
    // literal "&#8202;" in the middle of the text and in every error sample.
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => codePoint(parseInt(n, 16)))
    // Collapse the whitespace that stripping tags leaves behind, but keep
    // line structure: some parsers match per line.
    .replace(/[ \t]{2,}/g, ' ')
    // Stripping a tag leaves whitespace behind, so "</strong>," becomes " ,".
    // Bank notifications are one long sentence and their parsers read the
    // punctuation, so put it back against the word it belongs to.
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Entity code point to text. Anything in the space-separator category becomes
 * an ordinary space, so field patterns can rely on [ \t] meaning "gap".
 */
function codePoint(n) {
  if (!Number.isFinite(n) || n < 9 || n > 0x10ffff) return ' ';
  const ch = String.fromCodePoint(n);
  return /\s|\u00a0|\u2000-\u200a|\u202f|\u205f|\u3000/.test(ch) ? ' ' : ch;
}
