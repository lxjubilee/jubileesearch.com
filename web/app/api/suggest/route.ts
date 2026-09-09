import { NextResponse } from 'next/server';
import { contentRequest } from '@/lib/api';

// Receives the content-request form (§13.5).
//
// A route handler taking a normal form POST, not a fetch from a click handler,
// so the form works with JavaScript disabled and before hydration -- the same
// reasoning as SearchBox's real <form method="GET">. The reply is a redirect,
// which is also what stops a refresh from re-submitting it.

export const dynamic = 'force-dynamic';

function back(request: Request, params: Record<string, string>) {
  // Built from the request's own origin so it is right behind the tunnel and on
  // 127.0.0.1 alike; Next normalises request.url to the bound host.
  const url = new URL('/suggest', new URL(request.url).origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 303);   // 303: turn the POST into a GET
}

export async function POST(request: Request) {
  const form = await request.formData();
  const q = String(form.get('q') ?? '').trim();
  const note = String(form.get('note') ?? '').trim();
  const lang = String(form.get('lang') ?? '').trim();

  // The query is what makes the request legible to the writing team. Without
  // it there is nothing to file the note against.
  if (!q) return back(request, { error: 'missing' });

  const ok = await contentRequest({
    q,
    note: note || undefined,
    lang: lang || undefined,
  });

  // A failure is told plainly rather than shown a thank-you it did not earn.
  return ok ? back(request, { sent: '1', q }) : back(request, { error: 'engine', q });
}
