/**
 * Putting a charge's real timestamp back.
 *
 * The app's edit sheet once took a charge's date by slicing the UTC
 * timestamp — which for anything after 6pm Costa Rica is already tomorrow —
 * and wrote it back as noon of that day. Every charge reviewed by hand lost
 * the minute the bank recorded, and the late ones moved a day forward.
 *
 * The emails still hold the truth and the parsers already read it correctly.
 * What stops an ordinary re-sync from fixing this is `ignoreDuplicates`,
 * which exists to protect exactly the hand edits that must be kept. So this
 * is the narrow exception: one column, matched on ext_id, and only where it
 * actually differs.
 *
 * Everything the sync would otherwise overwrite — a category, a renamed
 * merchant, a reimbursement, a corrected account — is not in the update at
 * all, so it cannot be touched by a bug here later.
 */

/**
 * @param {object} db      a supabase-js client
 * @param {string} userId
 * @param {Array}  rows    rows as toTransactionRow() built them
 */
export async function repairPostedAt(db, userId, rows) {
  const changed = [];
  let alreadyCorrect = 0;

  for (const r of rows) {
    const { data, error } = await db
      .from('transactions')
      .update({ posted_at: r.posted_at })
      .eq('user_id', userId)
      .eq('ext_id', r.ext_id)
      // Without this a second run rewrites the same values and reports them
      // as repairs, which would make it impossible to tell a finished job
      // from a looping one.
      .neq('posted_at', r.posted_at)
      .select('id, merchant_raw, posted_at');

    if (error) throw new Error(`repair: ${error.message}`);

    if ((data ?? []).length) {
      changed.push({ extId: r.ext_id, merchant: r.merchant_raw, postedAt: r.posted_at });
    } else {
      // Either already right, or not in the table — a charge that never
      // imported has nothing to repair and is not an error here.
      alreadyCorrect += 1;
    }
  }

  return { changed, alreadyCorrect };
}
