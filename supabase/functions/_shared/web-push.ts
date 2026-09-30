/**
 * Sending Web Push from an edge function, for the cutoff reminders and the
 * new-charge alerts alike.
 *
 * Secrets (Edge Functions -> Secrets, or `supabase secrets set`):
 *   VAPID_PUBLIC_KEY   \ the pair the app subscribes with; the public half
 *   VAPID_PRIVATE_KEY  / is also in app/src/push-config.js
 *   VAPID_SUBJECT      mailto: or https: contact the push services can reach
 *
 * Deno-only, unlike the rest of _shared/: nothing in the browser sends push.
 */
import webpush from 'npm:web-push@3.6.7';

export type Device = { endpoint: string; p256dh: string; auth: string };
export type SendResult = { ok: true } | { ok: false; gone: boolean; error: string };

const env = (k: string) => Deno.env.get(k) ?? '';

/** Why push cannot be sent with the secrets as they are, or null when it can. */
export function vapidProblem(): string | null {
  if (!env('VAPID_PUBLIC_KEY') || !env('VAPID_PRIVATE_KEY') || !env('VAPID_SUBJECT')) {
    return 'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT as function secrets.';
  }
  if (env('VAPID_SUBJECT').includes('REPLACE')) {
    return 'VAPID_SUBJECT is still the placeholder — set it to mailto:<your address> or the app’s https URL.';
  }
  return null;
}

/**
 * A `send(device, payload)` for these secrets. Call `vapidProblem()` first.
 *
 * `ttlSeconds` is how long the push service keeps trying a device that is
 * offline: a reminder is worth a day, a charge alert less.
 */
export function createSender(
  { ttlSeconds, urgency = 'normal' }: { ttlSeconds: number; urgency?: 'normal' | 'high' },
) {
  webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  return async (d: Device, payload: unknown): Promise<SendResult> => {
    try {
      await webpush.sendNotification(
        { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
        JSON.stringify(payload),
        // A push service that hangs must not hold the caller up for long.
        { TTL: ttlSeconds, urgency, timeout: 10_000 },
      );
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404 and 410 are the push service saying this device is gone for good.
      return {
        ok: false,
        gone: status === 404 || status === 410,
        error: `${status ?? ''} ${(err as Error).message}`.trim(),
      };
    }
  };
}
