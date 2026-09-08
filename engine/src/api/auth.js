// Admin authentication (§14, §17 Security).
//
// "Admin endpoints sit under /api/v1/admin/* and require a Jubilee ID with the
// `search_admin` right, issued through the Jubilee SSO authority. Never a
// separate password system."
//
// So there is no user table here, no password hashing, and no token minting.
// This module does one thing: turn a bearer token into a Jubilee ID and a set of
// rights, by asking the SSO authority. Everything about *who* someone is stays
// where it belongs.
//
// It fails closed. If SSO is not configured, or is unreachable, or answers
// anything but an active token, the answer is "no rights" -- not "assume yes
// because the network is having a bad day". An admin console that is briefly
// unavailable is a nuisance; one that admits an unauthenticated caller during an
// outage is an incident.

import { env } from '../config.js';

const CACHE_MS = 60_000;
const cache = new Map();

const RIGHTS = { admin: 'search_admin', viewer: 'search_viewer' };

/**
 * @returns {{jubilee_id: string|null, rights: string[], authenticated: boolean}}
 */
export async function identify(req) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return anonymous();

  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.identity;

  const identity = await introspect(token);
  cache.set(token, { at: Date.now(), identity });
  // The cache is a request-storm buffer, not a session store. Keeping it small
  // means a revoked token is honoured within a minute rather than a deploy.
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return identity;
}

async function introspect(token) {
  const url = process.env.SSO_INTROSPECT_URL;

  if (!url) {
    // Development escape hatch. Two independent conditions, and it is inert in
    // production regardless of what the env file says.
    if (process.env.ALLOW_INSECURE_ADMIN === 'true' && process.env.NODE_ENV !== 'production') {
      console.warn(JSON.stringify({ level: 'warn', at: 'auth',
        msg: 'ALLOW_INSECURE_ADMIN is on; every bearer token is treated as search_admin. Development only.' }));
      return { jubilee_id: `dev:${token.slice(0, 8)}`, rights: [RIGHTS.admin], authenticated: true };
    }
    return anonymous();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(process.env.SSO_CLIENT_SECRET
          ? { authorization: `Basic ${Buffer.from(
              `${process.env.SSO_CLIENT_ID ?? 'jubileesearch'}:${process.env.SSO_CLIENT_SECRET}`,
            ).toString('base64')}` }
          : {}),
      },
      body: new URLSearchParams({ token }),
      signal: controller.signal,
    });
    if (!res.ok) return anonymous();
    const json = await res.json();
    if (json?.active !== true) return anonymous();

    const rights = Array.isArray(json.rights) ? json.rights
      : String(json.scope ?? '').split(/\s+/).filter(Boolean);

    return {
      jubilee_id: json.sub ?? json.jubilee_id ?? null,
      rights,
      authenticated: true,
    };
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', at: 'auth.introspect', msg: err.message }));
    return anonymous();
  } finally {
    clearTimeout(timer);
  }
}

const anonymous = () => ({ jubilee_id: null, rights: [], authenticated: false });

export const isAdmin = (identity) => identity.rights.includes(RIGHTS.admin);
// §15: "A view-only right exists alongside the admin right." An admin implies it.
export const canView = (identity) => isAdmin(identity) || identity.rights.includes(RIGHTS.viewer);

export { RIGHTS };
