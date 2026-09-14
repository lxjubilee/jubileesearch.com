import 'server-only';

// ─────────────────────────────────────────────────────────────────────────
// Outbound transactional email — one choke point, Mailgun transport.
//
// Ported from kJubilee.com's lib/email.js: dependency-free, POSTing to the
// Mailgun HTTP API with the global fetch, so there is no SMTP client and no
// SDK to keep current.
//
// Provider is chosen from the environment:
//   MAILGUN_API_KEY + MAILGUN_DOMAIN set  → Mailgun
//   otherwise                             → dev transport, which LOGS the
//                                           message and returns success
// so a box with no keys still runs every code path end to end.
//
// `from` MUST be on the Mailgun sending domain: if jubileesearch.com publishes
// DMARC p=reject, a message from any other domain is thrown away by receivers.
//
// Click tracking is forced OFF on every send. Mailgun rewrites tracked links
// through its own host, and a one-time password-reset link that has been
// rewritten is a one-time link someone else's infrastructure can see and replay.
// ─────────────────────────────────────────────────────────────────────────

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || '';
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || 'jubileesearch.com';
const MAILGUN_BASE = process.env.MAILGUN_API_BASE || 'https://api.mailgun.net';

const DEFAULT_FROM = process.env.EMAIL_FROM || `JubileeSearch <noreply@${MAILGUN_DOMAIN}>`;

export const SITE_URL = (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'https://jubileesearch.com')
  .replace(/\/+$/, '');

const TIMEOUT_MS = Number.parseInt(process.env.EMAIL_TIMEOUT_MS || '15000', 10);

// Mailgun's test mode: authenticated, validated, logged, delivered to NOBODY.
const TEST_MODE = process.env.EMAIL_TEST_MODE === 'true';

export type Provider = 'mailgun' | 'dev';

export function provider(): Provider {
  if (process.env.EMAIL_PROVIDER === 'dev') return 'dev';
  return MAILGUN_API_KEY && MAILGUN_DOMAIN ? 'mailgun' : 'dev';
}

export const isConfigured = () => provider() === 'mailgun';

export interface Message { to: string; subject: string; text: string; html?: string; from?: string }
export interface SendResult { success: boolean; provider: Provider; id?: string | null; status?: number }

async function sendViaMailgun({ to, subject, text, html, from }: Message): Promise<SendResult> {
  const body = new URLSearchParams({
    from: from || DEFAULT_FROM,
    to,
    subject,
    text,
    'o:tracking': 'no',
    'o:tracking-clicks': 'no',
    'o:tracking-opens': 'no',
  });
  if (html) body.set('html', html);
  if (TEST_MODE) body.set('o:testmode', 'yes');

  try {
    const res = await fetch(`${MAILGUN_BASE}/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const payload = await res.text();
    if (!res.ok) {
      console.error('[email] mailgun rejected the message:', res.status, payload.slice(0, 300));
      return { success: false, provider: 'mailgun', status: res.status };
    }
    let id: string | null = null;
    try { id = (JSON.parse(payload) as { id?: string }).id ?? null; } catch { /* not JSON */ }
    return { success: true, provider: 'mailgun', id };
  } catch (e) {
    console.error('[email] mailgun unreachable:', (e as Error)?.message);
    return { success: false, provider: 'mailgun', status: 0 };
  }
}

// No keys: say what would have been sent and carry on. This is what lets the
// reset flow be exercised on a box that cannot send.
function sendViaDev({ to, subject, text }: Message): SendResult {
  console.log(`[email:dev] to=${to} subject=${JSON.stringify(subject)}\n${text}\n`);
  return { success: true, provider: 'dev' };
}

export async function sendEmail(message: Message): Promise<SendResult> {
  if (!message?.to || !message.subject) {
    return { success: false, provider: provider() };
  }
  return provider() === 'mailgun' ? sendViaMailgun(message) : sendViaDev(message);
}

// ── Templates ────────────────────────────────────────────────────────────
// The same table-based XHTML shell the family sends, in JubileeSearch's
// colours. Mail clients are not browsers: Outlook renders through Word, so the
// layout is nested tables, the button has a VML fallback, and every colour is
// set as an attribute as well as a style.
const BRAND = {
  accent: '#3DA5FF',
  accentInk: '#06182b',
  card: '#2d2d2d',
  page: '#c0c0c0',
  rule: '#404040',
  ink: '#ffffff',
  inkDim: '#cccccc',
  support: 'https://jubileeverse.com/support',
};

const LOGO_URL = () => `${SITE_URL}/images/personas/jubilee.png`;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildEmailHtml(
  { heading, subheading, expiryText, buttonText, actionUrl, footerNote }:
  { heading: string; subheading: string; expiryText: string; buttonText: string; actionUrl: string; footerNote: string },
): string {
  const url = escapeHtml(actionUrl);
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>JubileeSearch.com</title>
<style type="text/css">
  body { margin:0; padding:0; background-color:${BRAND.page}; }
  table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { border:0; outline:none; text-decoration:none; display:block; }
  a { text-decoration:none; }
</style>
</head>
<body style="margin:0; padding:0; background-color:${BRAND.page};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.page}" style="background-color:${BRAND.page};">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.card}" style="width:600px; max-width:600px; background-color:${BRAND.card}; border-radius:16px; border:3px solid ${BRAND.accent}; border-collapse:separate;">
        <tr><td align="center" style="padding:48px 40px;">
          <img src="${LOGO_URL()}" alt="JubileeSearch" width="72" height="72" style="display:block; border:3px solid ${BRAND.accent}; border-radius:50%;" />
          <div style="font-family:Arial,Helvetica,sans-serif; font-size:40px; font-weight:bold; color:${BRAND.ink}; line-height:1; padding-top:12px;">
            Jubilee<span style="color:${BRAND.accent};">Search</span>.com
          </div>
          <h1 style="margin:32px 0 16px 0; font-family:Arial,Helvetica,sans-serif; font-size:28px; font-weight:600; color:${BRAND.ink}; line-height:1.3;">${heading}</h1>
          <p style="margin:0 0 24px 0; font-family:Arial,Helvetica,sans-serif; font-size:16px; color:${BRAND.ink}; line-height:1.5;">${subheading}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:40px auto 0 auto;">
            <tr><td align="center">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:52px;v-text-anchor:middle;width:300px;" arcsize="16%" stroke="f" fillcolor="${BRAND.accent}">
              <w:anchorlock/>
              <center style="color:${BRAND.accentInk};font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:600;">${buttonText}</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${url}" target="_blank" style="display:inline-block; padding:16px 32px; background-color:${BRAND.accent}; color:${BRAND.accentInk}; font-family:Arial,Helvetica,sans-serif; font-size:16px; font-weight:600; text-decoration:none; border-radius:8px; mso-hide:all;">${buttonText}</a>
              <!--<![endif]-->
            </td></tr>
          </table>
          <p style="margin:20px 0 0 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; color:${BRAND.inkDim};">${expiryText}</p>
          <p style="margin:24px 0 0 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; color:${BRAND.inkDim}; line-height:1.6; word-break:break-all;">
            Or paste this into your browser:<br />
            <a href="${url}" style="color:${BRAND.accent}; text-decoration:none;">${url}</a>
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:40px;">
            <tr><td height="1" style="border-top:1px solid ${BRAND.rule}; font-size:0; line-height:0;">&nbsp;</td></tr>
          </table>
          <p style="margin:24px 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:${BRAND.ink}; line-height:1.5;">${footerNote}</p>
          <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:${BRAND.ink}; line-height:1.5;">Need help? Contact <a href="${BRAND.support}" style="color:${BRAND.accent}; text-decoration:none;">Jubilee Support</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function passwordResetEmail(
  { to, resetUrl, minutes, firstName }: { to: string; resetUrl: string; minutes: number; firstName?: string | null },
): Message {
  const hi = firstName || 'there';
  return {
    to,
    subject: 'Reset your JubileeSearch.com password',
    // Plain text is the message, not an afterthought: it is what a text-only
    // client shows, and what a spam filter reads when it distrusts the HTML.
    text: [
      `Hi ${hi},`,
      '',
      'Someone asked to reset the password for your Jubilee ID on JubileeSearch.com.',
      '',
      'Open this link to choose a new one:',
      resetUrl,
      '',
      `This link expires in ${minutes} minutes and can be used once.`,
      '',
      "If you didn't request a password reset, you can safely ignore this email and your password will stay the same.",
    ].join('\n'),
    html: buildEmailHtml({
      heading: 'Reset your password',
      subheading: `Hi ${escapeHtml(hi)}, click the button below to choose a new password.`,
      expiryText: `This link expires in ${minutes} minutes and can be used once.`,
      buttonText: 'Reset password',
      actionUrl: resetUrl,
      footerNote: "If you didn't request a password reset, you can safely ignore this email and your password will stay the same.",
    }),
  };
}

export function sendPasswordResetEmail(
  { to, token, minutes, firstName }: { to: string; token: string; minutes: number; firstName?: string | null },
): Promise<SendResult> {
  const resetUrl = `${SITE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return sendEmail(passwordResetEmail({ to, resetUrl, minutes, firstName }));
}
