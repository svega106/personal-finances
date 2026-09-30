/**
 * A stand-in for the web-push package, for handler.test.ts: what would have
 * been sent, and a push service that fails the way real ones do.
 */
// deno-lint-ignore-file no-explicit-any
export const pushed: { endpoint: string; payload: any; options: any }[] = [];

const webpush = {
  setVapidDetails(_subject: string, _publicKey: string, _privateKey: string) {},
  sendNotification(sub: { endpoint: string }, payload: string, options: any) {
    if (sub.endpoint.endsWith('/broken')) {
      return Promise.reject(Object.assign(new Error('upstream error'), { statusCode: 500 }));
    }
    if (sub.endpoint.endsWith('/gone')) {
      return Promise.reject(Object.assign(new Error('Gone'), { statusCode: 410 }));
    }
    pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
    return Promise.resolve({ statusCode: 201 });
  },
};

export default webpush;
