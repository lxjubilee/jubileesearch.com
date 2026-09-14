import type { Metadata } from 'next';
import { explainUrl, indexLog, num, AdminRequestFailed, NotAuthorised } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import {
  bumpVersionAction, dedupeAction, sweepCacheAction, reindexAction, purgePageAction, reembedAction,
} from '@/lib/admin-actions';
import { ToolButton } from '@/components/admin/ToolButton';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Pill, LoadFailed, Notice, Empty, when } from '@/components/admin/ui';

// Screen 10: index tools (§15).
//
// "Force reindex of a domain or page, purge, reembed, bump the cache version,
// and view the full ingest or crawl log for a given URL."
//
// The explain and the log share one URL box: an operator asking "why is this
// page not showing up" wants both answers on the same screen.

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
  let log = null;
  if (target) {
    try {
      page = await explainUrl(target);
    } catch (err) {
      lookupError = err instanceof AdminRequestFailed
        ? (err.status === 404 ? 'That URL is not in the index.' : err.message)
        : err instanceof NotAuthorised ? err.message : String(err);
    }
    try { log = await indexLog(target); } catch { /* the log is an extra */ }
  }

  return (
    <>
      <PageHead
        title="Index tools"
        sub="Diagnose a single URL, act on one page or one domain, and the maintenance actions that affect the whole index."
      />

      <Panel title="Explain a URL" note="why is this page not showing up?">
        <div className="panelBody">
          <form method="GET" className="formGrid">
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="ex-url">Page URL</label>
              <input id="ex-url" name="url" type="url" defaultValue={target} placeholder="https://jubileeverse.com/…" required />
            </div>
            <div><button type="submit" className="btn" data-tone="primary">Explain</button></div>
          </form>

          {lookupError && (
            <div className="notice" data-tone="bad" style={{ marginTop: 14, marginBottom: 0 }}>{lookupError}</div>
          )}

          {page && (
            <div style={{ marginTop: 16 }}>
              {page.servable ? (
                <Notice tone="good"><strong>This page is servable.</strong> It can appear in results now.</Notice>
              ) : (
                <Notice tone="warn"><strong>Not servable.</strong> {page.why_not_servable ?? 'No reason was given.'}</Notice>
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

              {admin && (
                <div className="actions" style={{ marginTop: 14 }}>
                  <ActionForm action={reindexAction}>
                    <input type="hidden" name="target" value={page.url} />
                    <SubmitButton>Reindex this page</SubmitButton>
                  </ActionForm>
                  <ActionForm action={reembedAction}>
                    <input type="hidden" name="target" value={page.url} />
                    <SubmitButton>Re-embed this page</SubmitButton>
                  </ActionForm>
                  <ActionForm action={purgePageAction}>
                    <input type="hidden" name="url" value={page.url} />
                    <SubmitButton tone="danger" confirm={`Purge ${page.url} from the index?\n\nThe page and its chunks are deleted and the index version is bumped.`}>
                      Purge this page
                    </SubmitButton>
                  </ActionForm>
                </div>
              )}
            </div>
          )}
        </div>
      </Panel>

      {target && log && (
        <Panel title="Ingest and crawl log" note={log.domain ? `${log.domain.host} · ${log.domain.ingest_mode} · ${log.domain.status}` : 'domain not registered'}>
          {log.domain && (
            <div className="panelBody" style={{ borderBottom: '1px solid var(--a-line-soft)', fontSize: 12.5, color: 'var(--a-ink-dim)' }}>
              Last run {when(log.domain.last_crawl_started)} → {when(log.domain.last_crawl_finished)} · next due {when(log.domain.next_crawl_due)}
            </div>
          )}
          {log.queue.length > 0 && (
            <div className="scroll">
              <table>
                <thead><tr><th>Queued</th><th>Source</th><th className="numCell">Priority</th><th>Scheduled</th><th>Claimed</th><th className="numCell">Attempts</th><th className="wrapCell">Last error</th></tr></thead>
                <tbody>
                  {log.queue.map((q, i) => (
                    <tr key={i}>
                      <td><Pill tone="accent">in queue</Pill></td><td>{q.source}</td>
                      <td className="numCell">{q.priority}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{when(q.scheduled_for)}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{q.claimed_by ? `${q.claimed_by} · ${when(q.claimed_at)}` : '—'}</td>
                      <td className="numCell">{q.attempts}</td>
                      <td className="wrapCell">{q.last_error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="scroll">
            <table>
              <thead><tr><th>When</th><th>Outcome</th><th className="numCell">HTTP</th><th className="wrapCell">Reason</th></tr></thead>
              <tbody>
                {log.crawl_failures.length === 0 ? (
                  <tr><td colSpan={4}><Empty>No fetch failures recorded for this URL.</Empty></td></tr>
                ) : log.crawl_failures.map((f, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(f.at)}</td>
                    <td><Pill tone={f.outcome === 'error' ? 'bad' : 'warn'}>{f.outcome}</Pill></td>
                    <td className="numCell">{f.status ?? '—'}</td>
                    <td className="wrapCell">{f.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="scroll">
            <table>
              <thead><tr><th>Run</th><th>Mode</th><th>Started</th><th>Finished</th><th className="numCell">Seen</th><th className="numCell">Changed</th><th className="numCell">Failed</th><th className="wrapCell">Error</th></tr></thead>
              <tbody>
                {log.ingest_runs.length === 0 ? (
                  <tr><td colSpan={8}><Empty>No ingest runs recorded for this domain.</Empty></td></tr>
                ) : log.ingest_runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">#{r.id}</td><td>{r.mode}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(r.started_at)}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(r.finished_at)}</td>
                    <td className="numCell">{num(r.pages_seen)}</td>
                    <td className="numCell">{num(r.pages_changed)}</td>
                    <td className="numCell" style={{ color: num(r.pages_failed) > 0 ? 'var(--a-bad)' : undefined }}>{num(r.pages_failed)}</td>
                    <td className="wrapCell">{r.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {admin ? (
        <>
          <Panel title="Act on a page or a domain" note="a URL acts on that page; a bare host acts on every page of the domain">
            <div className="panelBody" style={{ display: 'grid', gap: 14 }}>
              <ActionForm action={reindexAction}>
                <div className="formGrid">
                  <div style={{ gridColumn: '1 / span 2' }}>
                    <label htmlFor="ri-target">Reindex</label>
                    <input id="ri-target" name="target" type="text" required placeholder="https://jubileeverse.com/page  or  jubileeverse.com" />
                  </div>
                  <div><SubmitButton confirm="Reset change detection and schedule a fresh fetch for the target?">Reindex</SubmitButton></div>
                </div>
              </ActionForm>
              <ActionForm action={reembedAction}>
                <div className="formGrid">
                  <div style={{ gridColumn: '1 / span 2' }}>
                    <label htmlFor="re-target">Re-embed</label>
                    <input id="re-target" name="target" type="text" required placeholder="https://jubileeverse.com/page  or  jubileeverse.com" />
                  </div>
                  <div><SubmitButton confirm="Clear the vectors for the target so the embed job redoes them?">Re-embed</SubmitButton></div>
                </div>
              </ActionForm>
              <ActionForm action={purgePageAction}>
                <div className="formGrid">
                  <div style={{ gridColumn: '1 / span 2' }}>
                    <label htmlFor="pp-url">Purge one page</label>
                    <input id="pp-url" name="url" type="url" required placeholder="https://jubileeverse.com/page" />
                  </div>
                  <div><SubmitButton tone="danger" confirm="Delete this page and its chunks from the index?">Purge page</SubmitButton></div>
                </div>
              </ActionForm>
              <p className="sub" style={{ margin: 0 }}>
                Purging a whole domain is on the <a href="/admin/domains">Domains</a> screen, beside the registration it belongs to.
              </p>
            </div>
          </Panel>

          <Panel title="Maintenance" note="these affect the whole index">
            <div className="panelBody">
              <div className="actions">
                <ToolButton action={bumpVersionAction}
                  confirm={'Bump the index version?\n\nEvery cached result becomes stale at once and the next searches are all cache misses. Latency will spike briefly.'}>
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
        </>
      ) : (
        <Panel title="Maintenance">
          <div className="panelBody sub">
            These actions need <code>search_admin</code>. You can still explain a URL and read its log above.
          </div>
        </Panel>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th style={{ width: 140, borderBottom: '1px solid var(--a-line-soft)' }}>{label}</th>
      <td>{children}</td>
    </tr>
  );
}
