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
 *
 * Run by hand from the editor's Run menu when needed:
 *   resyncLast30Days      re-offer a month of mail, e.g. after fixing a parser
 *   repairDatesLast30Days put the real timestamps back on charges already
 *                         stored, without touching anything else about them
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
// Threads per search. A normal run fetches the handful since the last one,
// but a resync or a date repair asks for a month at a time, and BAC sends one
// thread per charge — 50 would silently cut that short.
var BATCH = 200;

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
  run_('import', null, true);
}

/**
 * Fetch a window of mail and post it.
 *
 * @param {string}  mode     'import' or 'repair-dates'
 * @param {number?} since    epoch seconds; null uses the watermark
 * @param {boolean} advance  whether a successful run moves the watermark
 *
 * A repair never advances it. The watermark's job is to say what has been
 * offered for import, and a repair imports nothing — moving it would step
 * over any charge in that window that had failed to import, which is the one
 * thing this sync must never do quietly.
 */
function run_(mode, since, advance) {
  var url = PROPS.getProperty('INGEST_URL');
  var secret = PROPS.getProperty('INGEST_SECRET');
  if (!url || !secret) throw new Error('Set INGEST_URL and INGEST_SECRET in Script properties.');

  // UrlFetchApp reports a placeholder left in the URL as "Invalid argument",
  // which says nothing about the cause. Catch it here and say what to fix.
  if (url.indexOf('<') !== -1 || url.indexOf('>') !== -1) {
    throw new Error(
      'INGEST_URL still contains a placeholder: ' + url + '\n' +
      'Replace it with your project ref, e.g. ' +
      'https://abcdefghijklm.supabase.co/functions/v1/ingest-email\n' +
      '(Supabase dashboard -> Project Settings -> General -> Reference ID)');
  }
  if (url.indexOf('/functions/v1/ingest-email') === -1) {
    throw new Error('INGEST_URL should end in /functions/v1/ingest-email, got: ' + url);
  }

  if (since === null || since === undefined) {
    since = Number(PROPS.getProperty(WATERMARK) || 0);
    if (!since) since = Math.floor(Date.now() / 1000) - 30 * 86400;
  }

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

      // Both renderings go over. getPlainBody() is Apps Script's own
      // conversion — a black box that differs per bank layout and cannot be
      // covered by a test here. The raw HTML lets the server convert it with
      // code that is under test, and try again if the plain text will not
      // parse. A Davivienda charge went missing for days because only the
      // first of these was sent.
      messages.push({
        id: m.getId(),
        from: m.getFrom(),
        subject: m.getSubject(),
        body: m.getPlainBody(),
        html: trimHtml(m.getBody())
      });
      if (epoch > newest) newest = epoch;
    }
  }

  if (!messages.length) {
    Logger.log('Nothing new since ' + new Date(since * 1000));
    return;
  }

  // Posted in chunks: the ingest refuses more than 200 messages at once, and
  // a month of mail can exceed that. A chunk that fails stops the run, so the
  // watermark does not move past messages that were never offered.
  var CHUNK = 100;
  var totals = { imported: 0, duplicates: 0, unmatchedAccount: 0,
                 repaired: 0, alreadyCorrect: 0 };
  var failed = [];
  var changed = [];

  for (var c = 0; c < messages.length; c += CHUNK) {
    var batch = messages.slice(c, c + CHUNK);
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-ingest-secret': secret },
      payload: JSON.stringify({ messages: batch, mode: mode }),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    var text = res.getContentText();

    // The watermark only moves on success. A failed run must re-fetch the
    // same messages next time rather than skipping past them.
    if (code !== 200) {
      throw new Error('Ingest failed (' + code + ') on messages '
        + (c + 1) + '-' + (c + batch.length) + ': ' + text.slice(0, 500));
    }

    var r;
    try {
      r = JSON.parse(text);
    } catch (e) {
      throw new Error('Ingest returned something that is not JSON: ' + text.slice(0, 300));
    }

    totals.imported += (r.imported || 0);
    totals.duplicates += (r.duplicates || 0);
    totals.unmatchedAccount += (r.unmatchedAccount || 0);
    totals.repaired += (r.repaired || 0);
    totals.alreadyCorrect += (r.alreadyCorrect || 0);
    changed = changed.concat(r.changed || []);
    failed = failed.concat((r.skipped || []).filter(function (x) {
      return x.reason === 'parse-error';
    }));
  }

  if (advance) PROPS.setProperty(WATERMARK, String(newest));

  // Say plainly what happened. A run that sends five charges and imports none
  // used to read as a success, because the POST returned 200.
  var summary;
  if (mode === 'repair-dates') {
    summary = 'sent ' + messages.length + ', dates corrected ' + totals.repaired
            + ', already correct ' + totals.alreadyCorrect;
    changed.slice(0, 40).forEach(function (x) {
      summary += '\n    ' + x.merchant + ' -> ' + x.postedAt;
    });
    if (changed.length > 40) {
      summary += '\n    ... and ' + (changed.length - 40) + ' more';
    }
  } else {
    summary = 'sent ' + messages.length + ', imported ' + totals.imported
            + ', duplicates ' + totals.duplicates;
    if (totals.unmatchedAccount) {
      summary += ', ' + totals.unmatchedAccount + ' with no matching card';
    }
  }
  if (failed.length) {
    summary += '\n*** ' + failed.length + ' COULD NOT BE PARSED — those charges are not in the app:';
    failed.forEach(function (f) {
      summary += '\n    ' + (f.issuer || '?') + ': ' + f.detail
               + '\n      saw: ' + (f.sample || '(no sample)');
    });
  }
  Logger.log(summary);
}

/**
 * Keep the payload sane: drop inline image data and cap the length. Bank
 * notification markup is small once the base64 is gone, and the sentence the
 * parsers need is always near the top.
 */
function trimHtml(html) {
  var s = String(html || '').replace(/src="data:[^"]*"/gi, 'src=""');
  return s.length > 120000 ? s.slice(0, 120000) : s;
}

/** Kept only for resilience if a bank ever sends no HTML at all. */
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

/**
 * Re-import a window by hand, e.g. after fixing a parser.
 *
 * Re-importing is safe: the ingest function ignores a charge whose ext_id is
 * already stored, so anything you have already categorized is left alone.
 */
function resyncLastDays(days) {
  PROPS.setProperty(WATERMARK, String(Math.floor(Date.now() / 1000) - (days || 7) * 86400));
  syncNow();
}

/**
 * Put the real timestamps back, from the emails that brought the charges in.
 *
 * The app's edit sheet once read a charge's date off the UTC timestamp and
 * wrote it back as noon, so every charge reviewed by hand lost the minute the
 * bank recorded — and anything after 6pm Costa Rica gained a day. This
 * re-reads the mail and corrects `posted_at` and nothing else: categories,
 * renamed merchants, reimbursements and account corrections are left exactly
 * as they are.
 *
 * Safe to run more than once. The second run reports everything as already
 * correct.
 */
function repairDates(days) {
  run_('repair-dates', Math.floor(Date.now() / 1000) - (days || 30) * 86400, false);
}

// The editor's Run button cannot pass arguments — it calls the selected
// function with none. These wrappers exist so a backfill can be run from the
// dropdown without editing code.
function resyncLast7Days()  { resyncLastDays(7); }
function resyncLast30Days() { resyncLastDays(30); }
function resyncLast90Days() { resyncLastDays(90); }

function repairDatesLast30Days() { repairDates(30); }
function repairDatesLast90Days() { repairDates(90); }
