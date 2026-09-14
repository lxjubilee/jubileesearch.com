import 'server-only';
import { NextResponse } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────
// Request throttling for the Jubilee ID door.
//
// Ported from kJubilee.com's `lib/api.js` (`createRateLimiter`, `clientIp`,
// `ssoAuthLimiter`) so the two doors resist guessing the same way. kJubilee
// inherited these semantics from express-rate-limit's MemoryStore; this is the
// same behaviour written against a Web `Request`.
//
// WHY THIS EXISTS AT ALL. The door hands every attempt straight to the Jubilee
// ID authority, so an unthrottled route here lets one client spend the whole
// family's password-guessing budget — and `/api/sso/signup/lookup` answers
// "does this address have a Jubilee ID", which is an enumeration oracle for
// every address someone cares to try. Neither is protected by the engine's
// limiter: that one guards `/api/v1/*` on the engine, and these routes never
// reach it.
//
// PER-PROCESS, like the original. A multi-instance deploy needs a shared store
// here exactly as it did on kJubilee — the limit is per Node process, so N
// instances behind a load balancer allow N times the budget. Documented rather
// than solved, because the fix is a Redis dependency neither site has yet.
// ─────────────────────────────────────────────────────────────────────────

/** trust proxy 1 — the same assumption kJubilee's server.js makes. */
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') || 'unknown';
}

interface Entry { count: number; reset: number }

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  message: unknown;
}

/**
 * A limiter returns the 429 `Response` to send, or null to let the request
 * through — so a route reads `const limited = limiter(request); if (limited)
 * return limited;`, which is as close to the Express middleware it replaces as
 * a route handler gets.
 */
export type RateLimiter = (request: Request) => NextResponse | null;

export function createRateLimiter({ windowMs, max, message }: RateLimiterOptions): RateLimiter {
  const store = new Map<string, Entry>();

  return function limit(request: Request): NextResponse | null {
    const now = Date.now();
    const key = clientIp(request);

    let entry = store.get(key);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      store.set(key, entry);
    }
    entry.count += 1;

    // Bound the store, so a spray across many addresses cannot grow it without
    // limit. Only expired windows are dropped, so nobody's live budget is reset
    // by someone else's traffic.
    if (store.size > 10_000) {
      for (const [k, v] of store) if (now > v.reset) store.delete(k);
    }

    const remaining = Math.max(0, max - entry.count);
    const headers: Record<string, string> = {
      'RateLimit-Limit': String(max),
      'RateLimit-Remaining': String(remaining),
      'RateLimit-Reset': String(Math.ceil((entry.reset - now) / 1000)),
    };

    if (entry.count > max) {
      const retry = String(Math.ceil((entry.reset - now) / 1000));
      return NextResponse.json(message, {
        status: 429,
        headers: { ...headers, 'Retry-After': retry },
      });
    }
    return null;
  };
}

// The door's own budget. kJubilee's note applies unchanged: a limit sized for
// ordinary browsing is far too generous for guessing a password, so the auth
// routes get their own.
//
// Kept on globalThis so `next dev`'s hot reload does not hand an attacker a
// fresh window on every file save.
const globalForLimiters = globalThis as typeof globalThis & {
  __jsSsoAuthLimiter?: RateLimiter;
};

export const ssoAuthLimiter: RateLimiter =
  globalForLimiters.__jsSsoAuthLimiter
  || createRateLimiter({
    windowMs: Number.parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 min
    max: Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || '30', 10),
    message: {
      success: false,
      error: 'Too many attempts. Please wait a few minutes and try again.',
    },
  });

globalForLimiters.__jsSsoAuthLimiter = ssoAuthLimiter;
