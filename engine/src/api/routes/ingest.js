// Publish-time push (R6, §9.2).
//
// "Target: searchable within 60 seconds of publication." Acceptance criterion 2
// verifies it end to end, so the handler does the work inline rather than only
// enqueuing it: read the source, map it, upsert the page and its chunks, and
// mark the chunks priority 1 for the embedding job. The lexical path is live the
// moment this returns; the vector path follows within the embedding job's cycle.
//
// The nightly reconciliation does not go away. §9.2 is emphatic: "Webhooks are
// an optimization, never the sole source of truth."

import { verifyWebhook, consumeSignature } from '../../ingest/hmac.js';
import { readSource } from '../../ingest/source.js';
import { mapToPage } from '../../ingest/markdown.js';
import { upsertPage, markGone } from '../../ingest/service.js';

const exact = (path) => (p) => p === path;
const fail = (status, msg) => Object.assign(new Error(msg), { statusCode: status });

export const routes = [
  {
    method: 'POST', match: exact('/api/v1/ingest/notify'),
    // Authenticated by HMAC, not by SSO. Rate limiting is off: a publishing
    // system releasing a batch of forty articles is doing the right thing, and
    // the signature requirement already bounds who can do it at all.
    auth: false, rateLimit: false,
    handle: async ({ body, db, req }) => {
      const payload = body.parsed ?? {};
      const { host, source_path: sourcePath, url, event } = payload;

      if (!host || typeof host !== 'string') throw fail(400, 'host is required');
      if (!['publish', 'update', 'unpublish'].includes(event)) {
        throw fail(400, "event must be 'publish', 'update' or 'unpublish'");
      }

      const { rows } = await db.query(
        `SELECT id, host, tier, status, ingest_mode, source_root, url_template,
                webhook_secret, language_hint
           FROM domains WHERE host = $1`, [String(host).toLowerCase()]);
      const domain = rows[0];

      // A domain that is not registered gets the same answer as one whose
      // signature does not verify. Telling an unauthenticated caller which
      // hosts exist is a free reconnaissance of the estate.
      if (!domain) throw fail(401, 'unauthorized');

      const verdict = verifyWebhook({
        rawBody: body.raw,
        headers: req.headers,
        parsed: payload,
        secret: domain.webhook_secret,
      });
      if (!verdict.ok) throw fail(401, 'unauthorized');

      if (!(await consumeSignature(db, verdict.signature))) {
        throw fail(409, 'replayed request');
      }

      if (domain.tier !== 'T1') {
        throw fail(403, 'publish push is for owned (T1) domains only');
      }

      if (event === 'unpublish') {
        if (!url) throw fail(400, 'url is required to unpublish');
        const result = await markGone(domain.id, url);
        return { status: 200, body: { ...result, host: domain.host } };
      }

      if (!sourcePath) throw fail(400, 'source_path is required');
      if (!domain.source_root) {
        // Decision D5. Say so precisely rather than returning a generic 500 --
        // this is the error the publishing team will actually hit first.
        throw fail(409,
          `domain ${domain.host} has no source_root configured (decision D5). ` +
          'Set it in the admin console, or switch the domain to ingest_mode = crawl.');
      }

      const markdown = await readSource(domain.source_root, sourcePath);
      if (markdown === null) {
        throw fail(404, `no source document at ${sourcePath} under the configured source_root`);
      }

      const mapped = mapToPage(markdown, domain, sourcePath);
      // The webhook's `url` wins over the one composed from the template: the
      // publishing system knows where it actually published.
      if (url) mapped.url = url;

      const result = await upsertPage(domain, mapped, markdown, { priority: 1 });

      await db.query(
        `INSERT INTO ingest_runs (domain_id, mode, finished_at, pages_seen, pages_changed)
         VALUES ($1, 'webhook', now(), 1, $2)`,
        [domain.id, result.status === 'unchanged' ? 0 : 1]);

      return {
        status: 200,
        body: {
          ...result,
          host: domain.host,
          url: mapped.url,
          // Honest about the two halves of freshness: lexical is live now, the
          // vector path waits on the embedding job.
          searchable: result.status !== 'rejected' ? 'lexical now, semantic on next embedding cycle' : 'no',
          frontmatter_error: mapped.frontmatter_error,
        },
      };
    },
  },
];
