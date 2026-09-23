/**
 * Gmail -> Personal Finances sync.
 *
 * Runs inside the Google account on a time trigger. It only fetches and
 * forwards: every bank-specific rule lives in the repo, in
 * supabase/functions/_shared/parsers.js, where it is covered by tests. Nothing
 * here should ever need to know what a Davivienda email looks like.
 *
 * Why Apps Script rather than the Gmail API from a server: a server needs an
 * OAuth client, and Google expires refresh tokens after 7 days while the
 * consent screen is in "Testing" — a weekly-dying cron job. This runs as the
 * account itself, so there is no token to rotate and nothing to verify.
 *
 * Setup:
 *   1. script.google.com -> New project -> paste this file
 *   2. Project Settings -> Script properties:
 *        INGEST_URL     https://<project-ref>.supabase.co/functions/v1/ingest-email
 *        INGEST_SECRET  the same value set as a Supabase secret
 *   3. Run `setUp` once and approve the Gmail permission prompt
 *   4. Triggers -> add trigger -> syncNow, time-driven, every 15 minutes
 */

/** Senders worth fetching. The parsers decide what is actually a charge. */
var SENDERS = [
  'notificacionbac@baccredomatic.cr',
  'costarica_clientes@davivienda.cr',
  'info@promerica.fi.cr',
  'bncontacto@bncr.fi.cr'
];

var PROPS = PropertiesService.getScriptProperties();
var WATERMARK = 'lastSyncedEpoch';
var BATCH = 50;

/** Run once by hand: grants Gmail access and sets the starting point. */
function setUp() {
  GmailApp.getInboxUnreadCount(); // forces the permission prompt
  if (!PROPS.getProperty(WATERMARK)) {
    // Start from 30 days back, so the first run picks up the current month.
    var from = Math.floor(Date.now() / 1000) - 30 * 86400;
    PROPS.setProperty(WATERMARK, String(from));
  }
  Logger.log('Ready. Watermark: ' + new Date(Number(PROPS.getProperty(WATERMARK)) * 1000));
}

function syncNow() {
  var url = PROPS.getProperty('INGEST_URL');
  var secret = PROPS.getProperty('INGEST_SECRET');
  if (!url || !secret) throw new Error('Set INGEST_URL and INGEST_SECRET in Script properties.');

  var since = Number(PROPS.getProperty(WATERMARK) || 0);
  if (!since) since = Math.floor(Date.now() / 1000) - 30 * 86400;

  // One second of overlap on purpose: Gmail's `after:` is second-resolution,
  // so a message arriving in the same second as the last run could be missed.
  // Re-sending a charge is free — the ingest function ignores duplicates by
  // ext_id — whereas missing one is silent and permanent.
  var query = 'from:{' + SENDERS.join(' ') + '} after:' + (since - 1);

  var threads = GmailApp.search(query, 0, BATCH);
  var messages = [];
  var newest = since;

  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      var epoch = Math.floor(m.getDate().getTime() / 1000);
      if (epoch < since - 1) continue; // older message on a thread that was bumped

      messages.push({
        id: m.getId(),
        from: m.getFrom(),
        subject: m.getSubject(),
        // Plain text where the bank sends it; otherwise the HTML stripped down.
        // The parsers normalize both shapes to the same thing.
        body: m.getPlainBody() || htmlToText(m.getBody())
      });
      if (epoch > newest) newest = epoch;
    }
  }

  if (!messages.length) {
    Logger.log('Nothing new since ' + new Date(since * 1000));
    return;
  }

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': secret },
    payload: JSON.stringify({ messages: messages }),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var text = res.getContentText();

  // The watermark only moves on success. A failed run must re-fetch the same
  // messages next time rather than skipping past them.
  if (code !== 200) {
    throw new Error('Ingest failed (' + code + '): ' + text.slice(0, 500));
  }

  PROPS.setProperty(WATERMARK, String(newest));
  Logger.log('Sent ' + messages.length + ' message(s). Response: ' + text.slice(0, 500));
}

/** Crude but adequate: the parsers only need readable text and line breaks. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d)>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Re-import a window by hand, e.g. after fixing a parser. */
function resyncLastDays(days) {
  PROPS.setProperty(WATERMARK, String(Math.floor(Date.now() / 1000) - (days || 7) * 86400));
  syncNow();
}
