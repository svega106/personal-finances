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
