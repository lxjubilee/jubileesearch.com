import type { Metadata } from 'next';
import { explainUrl, num, AdminRequestFailed, NotAuthorised } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import { bumpVersionAction, dedupeAction, sweepCacheAction } from '@/lib/admin-actions';
import { ToolButton } from '@/components/admin/ToolButton';
import { PageHead, Panel, Pill, LoadFailed, Notice, when } from '@/components/admin/ui';

// Screen 10: index tools (§15).
//
// "Force reindex of a domain or page, purge, reembed, bump the cache version,
// and view the full ingest or crawl log for a given URL."
//
// The explain box answers the question this screen exists for: *why is this
// page not showing up?* P4 makes results explainable to a reader; this is the
// same principle turned on the index for an operator, and the engine already
// computes `why_not_servable` rather than leaving it to be inferred from a row
// of flags.
//
// The lookup is a GET form, so a diagnosis has its own URL and can be pasted
// into a ticket.

export const metadata: Metadata = { title: 'Index tools' };

export default async function IndexToolsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const target = one(params.url).trim();

  const session = await getSession();
  const admin = isAdmin(session);

  let page = null;
  let lookupError = '';
  if (target) {
    try {
      page = await explainUrl(target);
    } catch (err) {
      lookupError = err instanceof AdminRequestFailed
        ? (err.status === 404 ? 'That URL is not in the index.' : err.message)
        : err instanceof NotAuthorised ? err.message : String(err);
    }
  }

  return (
    <>
      <PageHead
        title="Index tools"
        sub="Diagnose a single URL, and the maintenance actions that affect the whole index."
      />

      <Panel title="Explain a URL" note="why is this page not showing up?">
        <div className="panelBody">
          {/* A plain GET form: the result is addressable. */}
          <form method="GET" className="formGrid">
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="ex-url">Page URL</label>
              <input
                id="ex-url"
                name="url"
                type="url"
                defaultValue={target}
                placeholder="https://jubileeverse.com/…"
                required
              />
            </div>
            <div><button type="submit" className="btn" data-tone="primary">Explain</button></div>
          </form>

          {lookupError && (
            <div className="notice" data-tone="bad" style={{ marginTop: 14, marginBottom: 0 }}>
              {lookupError}
            </div>
          )}

          {page && (
            <div style={{ marginTop: 16 }}>
              {page.servable ? (
                <Notice tone="good">
                  <strong>This page is servable.</strong> It can appear in results now.
                </Notice>
              ) : (
                <Notice tone="warn">
                  <strong>Not servable.</strong> {page.why_not_servable ?? 'No reason was given.'}
                </Notice>
              )}

              <div className="scroll">
                <table>
                  <tbody>
                    <Row label="URL"><span className="mono">{page.url}</span></Row>
                    <Row label="Host"><span className="mono">{page.host}</span></Row>
                    <Row label="Page status"><Pill tone={page.status === 'indexed' ? 'good' : 'warn'}>{page.status}</Pill></Row>
                    <Row label="Domain status">
                      <Pill tone={page.domain_status === 'active' ? 'good' : 'bad'}>{page.domain_status}</Pill>
                      {' '}<Pill>{page.tier}</Pill>
                      {page.zone_a_eligible && <> <Pill tone="good">Zone A eligible</Pill></>}
                    </Row>
                    <Row label="Safety">
                      <Pill tone={page.safety_verdict === 'safe' ? 'good' : page.safety_verdict === 'unsafe' ? 'bad' : 'warn'}>
                        {page.safety_verdict ?? 'unclassified'}
                      </Pill>
                      {page.suppressed && <> <Pill tone="bad">suppressed</Pill></>}
                    </Row>
                    <Row label="Chunks">
                      {num(page.embedded_chunks)} of {num(page.chunks)} embedded
                      {num(page.chunks) > 0 && num(page.embedded_chunks) === 0 && (
                        <span style={{ color: 'var(--a-warn)' }}> — no semantic matching for this page</span>
                      )}
                    </Row>
                    <Row label="Words">{num(page.word_count).toLocaleString()} · {page.language ?? 'unknown'}</Row>
                    <Row label="Fetched">{when(page.last_fetched_at)} · {num(page.fetch_failures)} failure(s)</Row>
                    <Row label="Indexed">{when(page.last_indexed_at)}</Row>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Panel>

      {admin ? (
        <Panel title="Maintenance" note="these affect the whole index">
          <div className="panelBody">
            <div className="actions">
              <ToolButton
                action={bumpVersionAction}
                confirm={'Bump the index version?\n\nEvery cached result becomes stale at once and the next searches are all cache misses. Latency will spike briefly.'}
              >
                Bump index version
              </ToolButton>
              <ToolButton action={dedupeAction}>Mark exact duplicates</ToolButton>
              <ToolButton action={sweepCacheAction}>Sweep expired cache rows</ToolButton>
            </div>
            <p className="sub" style={{ marginTop: 12 }}>
              Bumping the version is how a ranking or safety change is made to take effect
              immediately. Deduplication marks exact-hash duplicates so only one of a set is served.
            </p>
          </div>
        </Panel>
      ) : (
        <Panel title="Maintenance">
          <div className="panelBody sub">
            These actions need <code>search_admin</code>. You can still explain a URL above.
          </div>
        </Panel>
      )}

      <p className="sub">
        Not yet on this screen: forced reindex of a single page or domain, per-page purge, and
        re-embedding. Purging a whole domain is on the <a href="/admin/domains">Domains</a> screen;
        the finer-grained versions have no endpoint yet.
      </p>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th style={{ width: 150, verticalAlign: 'top' }}>{label}</th>
      <td>{children}</td>
    </tr>
  );
}
