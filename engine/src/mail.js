// Outbound mail for jobs (the content-gap report, §16).
//
// The same shape as web/lib/email.ts: Mailgun over its HTTP API with the
// global fetch, no SDK, and a dev transport that logs instead of sending when
// no keys are set, so every job runs end to end on a box that cannot send.
//
//   MAILGUN_API_KEY + MAILGUN_DOMAIN   -> Mailgun
//   otherwise                          -> dev (logged, success)
//   EMAIL_TEST_MODE=true               -> Mailgun validates and logs but
//                                         delivers to nobody (o:testmode)
//
// `from` must be on the sending domain (DMARC). Tracking is off: a report
// with links in it is not a marketing message.

const API_KEY = process.env.MAILGUN_API_KEY || '';
const DOMAIN = process.env.MAILGUN_DOMAIN || '';
const BASE = process.env.MAILGUN_API_BASE || 'https://api.mailgun.net';
const FROM = process.env.EMAIL_FROM || (DOMAIN ? `JubileeSearch <noreply@${DOMAIN}>` : 'JubileeSearch <noreply@localhost>');
const TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS || 15000);
const TEST_MODE = process.env.EMAIL_TEST_MODE === 'true';

export function provider() {
  if (process.env.EMAIL_PROVIDER === 'dev') return 'dev';
  return API_KEY && DOMAIN ? 'mailgun' : 'dev';
}

/**
 * @param {{to: string|string[], subject: string, text: string,
 *          attachments?: {filename: string, content: string|Buffer, type?: string}[]}} msg
 * @param {{fetch?: typeof fetch}} [deps]  injectable for tests
 * @returns {Promise<{success: boolean, provider: string, id?: string|null, status?: number}>}
 */
export async function send(msg, deps = {}) {
  const to = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to;
  if (provider() === 'dev') {
    console.log(JSON.stringify({ level: 'info', at: 'mail.dev', to, subject: msg.subject,
      bytes: msg.text.length, attachments: (msg.attachments ?? []).map((a) => a.filename) }));
    return { success: true, provider: 'dev', id: null };
  }

  // multipart/form-data, because attachments cannot travel in a urlencoded
  // body. FormData and Blob are built into Node 18+.
  const form = new FormData();
  form.set('from', FROM);
  form.set('to', to);
  form.set('subject', msg.subject);
  form.set('text', msg.text);
  form.set('o:tracking', 'no');
  form.set('o:tracking-clicks', 'no');
  form.set('o:tracking-opens', 'no');
  if (TEST_MODE) form.set('o:testmode', 'yes');
  for (const a of msg.attachments ?? []) {
    form.append('attachment', new Blob([a.content], { type: a.type ?? 'application/octet-stream' }), a.filename);
  }

  const f = deps.fetch ?? fetch;
  try {
    const res = await f(`${BASE}/v3/${DOMAIN}/messages`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`api:${API_KEY}`).toString('base64') },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const payload = await res.text();
    if (!res.ok) {
      console.error(JSON.stringify({ level: 'error', at: 'mail.mailgun', status: res.status, body: payload.slice(0, 300) }));
      return { success: false, provider: 'mailgun', status: res.status };
    }
    let id = null;
    try { id = JSON.parse(payload).id ?? null; } catch { /* not JSON */ }
    return { success: true, provider: 'mailgun', id, status: res.status };
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', at: 'mail.mailgun', msg: err.message }));
    return { success: false, provider: 'mailgun', status: 0 };
  }
}
