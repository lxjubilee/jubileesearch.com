import { peekToken, completeReset } from '@/lib/password-reset';
import { json, readJson } from '@/lib/sso-door';
import { ssoAuthLimiter } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ported from kJubilee's app/api/auth/reset-password/route.js.

// GET /api/auth/reset-password?token=…
// Is this link still good? Asked before the new-password screen is drawn, so a
// dead link says so immediately instead of after someone types a password twice.
export async function GET(request: Request) {
  const limited = ssoAuthLimiter(request);
  if (limited) return limited;

  const token = new URL(request.url).searchParams.get('token') || '';
  const peek = await peekToken(token);
  // The address is echoed so the screen can show whose password is being set;
  // holding the token is already proof of reaching that mailbox.
  return json({ valid: peek.valid, email: peek.valid ? peek.email : undefined });
}

// POST /api/auth/reset-password  { token, password }
export async function POST(request: Request) {
  const limited = ssoAuthLimiter(request);
  if (limited) return limited;

  const body = await readJson(request);
  const result = await completeReset(String(body.token ?? ''), String(body.password ?? ''));
  if (!result.success) return json({ success: false, error: result.error }, 400);
  return json({ success: true, email: result.email });
}
