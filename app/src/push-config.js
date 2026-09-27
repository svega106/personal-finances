/**
 * The public half of the VAPID key pair reminders are sent with.
 *
 * Public by design — a browser needs it to subscribe, and it only proves the
 * sender, it grants nothing. The private half never leaves Supabase: it is a
 * secret of the send-cutoff-reminders function (see supabase/README.md).
 * The two must be a pair; replacing one means replacing both, and every
 * device subscribes again.
 */
export const VAPID_PUBLIC_KEY =
  'BDJ4wEg5fsxetQ-DXeAFyrtO7Z2O6aeiXM_YTOztVBL9OEv5fi-NtwvPzgEfEr6nzWcL2b_ZBAOg3GKrrq6IIE4';
