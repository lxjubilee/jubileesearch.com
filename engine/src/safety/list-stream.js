// Streaming helpers for the blocklist loader (bin/load-blocklists.mjs).
//
// Kept apart from the script so the tar reader and the line parser can be
// tested on a buffer, without a network and without a database.

/** Byte chunks -> text lines, without ever holding the whole body. */
export async function* splitLines(stream) {
  let rest = '';
  for await (const chunk of stream) {
    rest += chunk.toString('utf8');
    let at;
    while ((at = rest.indexOf('\n')) >= 0) {
      yield rest.slice(0, at);
      rest = rest.slice(at + 1);
    }
  }
  if (rest) yield rest;
}

/**
 * Pull one member out of a tar stream, by base name ("domains" matches
 * "adult/domains"). A tar is 512-byte headers followed by the file's bytes
 * padded to 512; that is all that is needed, so no dependency.
 */
export async function* tarMember(stream, wanted) {
  let buf = Buffer.alloc(0);
  let remaining = 0;      // bytes of the current member still to read
  let padding = 0;        // bytes to skip after it
  let emitting = false;

  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (remaining > 0) {
        const take = Math.min(remaining, buf.length);
        if (take === 0) break;
        if (emitting) yield buf.subarray(0, take);
        buf = buf.subarray(take);
        remaining -= take;
        if (remaining === 0 && emitting) return;   // the member we wanted is done
        continue;
      }
      if (padding > 0) {
        const take = Math.min(padding, buf.length);
        buf = buf.subarray(take);
        padding -= take;
        if (padding > 0) break;
        continue;
      }
      if (buf.length < 512) break;
      const header = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (header.every((b) => b === 0)) return;   // end-of-archive block
      const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
      const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
      const type = String.fromCharCode(header[156]);
      remaining = size;
      padding = (512 - (size % 512)) % 512;
      emitting = (type === '0' || type === '\0') && name.split('/').pop() === wanted;
    }
  }
}

export function parseLine(rawLine, source) {
  const line = rawLine.replace(/#.*$/, '').trim();
  if (!line) return null;

  let host = null;
  let matchType = 'host';

  switch (source.format) {
    case 'hosts': {
      // "0.0.0.0 example.com" or "127.0.0.1 example.com"
      const parts = line.split(/\s+/);
      if (parts.length < 2) return null;
      host = parts[1];
      // The sinkhole entries for localhost itself are not blocklist content.
      if (['localhost', 'localhost.localdomain', 'broadcasthost', 'ip6-localhost'].includes(host)) return null;
      break;
    }
    case 'domains':
      host = line.split(/\s+/)[0];
      break;
    case 'urls': {
      try {
        const url = new URL(line.includes('://') ? line : `http://${line}`);
        host = url.hostname;
        // A URL list is usually blocking a section of an otherwise fine site,
        // so blocking the whole host would be too broad.
        if (url.pathname && url.pathname !== '/') {
          return {
            pattern: `^https?://(www\\.)?${escapeRegex(url.hostname)}${escapeRegex(url.pathname)}`,
            matchType: 'regex',
          };
        }
      } catch { return null; }
      break;
    }
    default:
      throw new Error(`unknown format '${source.format}'`);
  }

  if (!host) return null;
  host = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  return { pattern: host, matchType };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
