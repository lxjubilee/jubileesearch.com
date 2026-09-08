// Reading T1 source markdown.
//
// ---------------------------------------------------------------------------
// Decision D5 is unanswered and is marked blocking on Phase 2: "Where does the
// T1 source markdown actually live, and what is the canonical path structure per
// domain? ... If it is CDN paths today and JubileePedia later, give me both and
// the mapper will handle the transition."
//
// So this reader takes `source_root` as it finds it and supports both shapes it
// could plausibly be:
//
//   https://cdn.example/...   fetched over HTTP
//   /var/www/content/...      read from the filesystem
//   W:\content\...            the same, on Windows
//
// A domain's source_root is joined to the webhook's `source_path` and nothing
// else is assumed about the layout. When D5 lands, the only thing that should
// need to change is `domains.source_root` -- and if the answer turns out to need
// a per-domain path transform, that belongs in a template column beside
// `url_template`, not in this file.
//
// The traversal guard below is not optional. `source_path` arrives in a webhook
// body, and a filesystem source_root plus an unchecked "../../../etc/passwd"
// would be a file-read primitive exposed to anything that holds a signing key.
// ---------------------------------------------------------------------------

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;   // same body cap the fetcher uses (§9.4)

export const isRemote = (root) => /^https?:\/\//i.test(String(root ?? ''));

export function safeJoin(root, relative) {
  const clean = String(relative ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((seg) => seg === '..')) {
    throw Object.assign(new Error('source_path may not traverse upwards'), { statusCode: 400 });
  }
  if (isRemote(root)) {
    return `${String(root).replace(/\/+$/, '')}/${clean}`;
  }
  const base = resolve(root);
  const full = resolve(join(base, clean));
  // resolve() collapses any traversal the segment check missed (symlinks aside);
  // this is the assertion that the result is still inside the root.
  if (full !== base && !full.startsWith(base + sep)) {
    throw Object.assign(new Error('source_path escapes source_root'), { statusCode: 400 });
  }
  return full;
}

export async function readSource(root, relativePath) {
  const location = safeJoin(root, relativePath);

  if (isRemote(root)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(location, {
        signal: controller.signal,
        headers: { 'user-agent': 'JubileeSearchBot/1.0 (+https://jubileesearch.com/bot)' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`source fetch returned ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('source document exceeds 5 MB');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const info = await stat(location);
    if (info.size > MAX_BYTES) throw new Error('source document exceeds 5 MB');
    return await readFile(location, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Enumerate every .md under a filesystem source_root (§9.1 step 1).
 *
 * A remote root cannot be walked over HTTP -- there is no directory listing to
 * read -- so a CDN-hosted domain needs either a manifest at a known path or a
 * sitemap. That is returned as an explicit error rather than an empty list,
 * because "no files found" and "cannot enumerate this kind of root" are
 * different problems and only one of them is a content problem.
 */
export async function enumerateMarkdown(root) {
  if (isRemote(root)) {
    const manifest = await readSource(root, 'search-manifest.json');
    if (!manifest) {
      throw new Error(
        `cannot enumerate remote source_root ${root}: no search-manifest.json. ` +
        'A CDN root needs a manifest listing its .md paths, or the domain should ' +
        'run ingest_mode = crawl until decision D5 settles the layout.');
    }
    const parsed = JSON.parse(manifest);
    const paths = Array.isArray(parsed) ? parsed : parsed.paths;
    if (!Array.isArray(paths)) throw new Error('search-manifest.json must be an array of paths, or {"paths": [...]}');
    return paths.filter((p) => /\.mdx?$/i.test(p));
  }

  const out = [];
  await walk(resolve(root), '', out);
  return out;
}

async function walk(base, relative, out) {
  const entries = await readdir(join(base, relative), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'build'].includes(entry.name)) continue;
      await walk(base, next, out);
    } else if (/\.mdx?$/i.test(entry.name)) {
      out.push(next);
    }
  }
}
