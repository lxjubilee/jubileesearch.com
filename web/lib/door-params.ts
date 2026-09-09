import 'server-only';

// Query-string handling for the Jubilee ID door, read on the SERVER and handed
// to the client component as props. Ported from kJubilee's lib/door-params.js.
//
// The door could call useSearchParams(), which forces the whole subtree out of
// server rendering -- the page comes back as an empty shell and the form only
// appears after hydration. Reading them here instead means the sign-in screen is
// in the first response, and it puts the redirect-safety rule in one place that
// /signin, /login and /signup all share.

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export interface DoorParams {
  returnUrl: string;
  initialEmail: string;
  initialError: string;
}

export function doorParams(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): DoorParams {
  const sp = searchParams || {};
  const get = (k: string) => {
    const v = first(sp[k]);
    return typeof v === 'string' ? v : '';
  };

  // Only same-origin, root-relative paths are followed, so a crafted ?next=
  // cannot bounce someone off the site after they sign in. "//evil.example" is
  // protocol-relative and would leave -- hence the second test.
  const raw = get('next') || get('redirect') || get('returnTo') || '/';
  const returnUrl = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

  return {
    returnUrl,
    initialEmail: get('email').trim(),
    initialError: get('error'),
  };
}
