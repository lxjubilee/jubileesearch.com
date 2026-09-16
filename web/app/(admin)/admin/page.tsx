import type { Metadata } from 'next';
import Link from 'next/link';
import { getDashboard, getZoneCtr, getAnalyticsOverview, num, AdminRequestFailed } from '@/lib/admin';
import { health } from '@/lib/api';
import { PageHead, Panel, Tile, Notice, LoadFailed, pct } from '@/components/admin/ui';

// Screen 1: dashboard (§15).
//
// "Index size by tier, pages ingested and changed in the last 24 hours, webhook
// success rate, embedding backlog, safety queue depth, failed domains, p95
// latency, cache hit rate, top queries, zero-result queries, Zone A coverage
// rate."
//
// Acceptance criterion 27 is "Admin console counts match direct database
// counts", so every number here is rendered exactly as the engine returned it.
// Nothing is rounded, scaled, smoothed or derived in this file except the two
// rates, which are formatted from the values the SQL computed. If a number looks
// wrong, the query is wrong -- there is no second arithmetic to check.

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  let data;
  let failure = '';
  try {
    data = await getDashboard();
  } catch (err) {
    failure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  let ctr = null;
  try { ctr = await getZoneCtr(); } catch { /* the tripwire is optional here */ }
  let overview = null;
  try { overview = await getAnalyticsOverview(7); } catch { /* top queries are an extra */ }

  if (!data) {
    return (
      <>
        <PageHead title="Dashboard" />
        <LoadFailed what="The dashboard" detail={failure} />
      </>
    );
  }

  const tiers = data.pages_by_tier ?? {};
  const indexed = Object.values(tiers).reduce<number>((a, b) => a + num(b), 0);
  const backlog = num(data.embedding_backlog);
  const engine = await health();
  const inference = engine?.inference ?? null;
  const embeddedChunks = num(engine?.index?.embedded_chunks);
  const safety = num(data.safety_queue);
  const failing = num(data.failing_domains);
  const webhooks = num(data.webhooks_24h);
  const webhookFailures = num(data.webhook_failures_24h);
  const p95 = num(data.p95_latency_ms);
  const emptyRate = num(data.zone_a_empty_rate);

  return (
    <>
      <PageHead
        title="Dashboard"
        sub="Every number is the engine's own count, shown unmodified — acceptance criterion 27 requires these to match the database exactly."
      />

      {/* The tripwire from the risk register, promoted to the top of the console
          because it is the one number that invalidates the ranking. */}
      {ctr?.zone_a_below_zone_b && (
        <Notice tone="bad">
          <strong>Zone A click-through is below Zone B.</strong> {ctr.note}{' '}
          <Link href="/admin/ranking">Raise the relevance floor</Link>.
        </Notice>
      )}

      {/* Two different situations share one number. No inference provider at
          all means the whole index is keyword-only and someone must act.
          A provider that is configured and a queue of new pages means the
          nightly job is working and the notice is informational. */}
      {backlog > 0 && !inference?.configured && (
        <Notice tone="warn">
          <strong>{backlog.toLocaleString()} chunks are waiting to be embedded.</strong>{' '}
          Until they are, searches run on word overlap alone: a query that shares no words
          with a page returns nothing. Check <code>INFERENCE_API_URL</code> is set and run{' '}
          <code>npm run inference:check</code>.
        </Notice>
      )}
      {backlog > 0 && inference?.configured && (
        <Notice tone="neutral">
          <strong>{backlog.toLocaleString()} newly indexed chunks are queued for embedding</strong>{' '}
          ({embeddedChunks.toLocaleString()} already embedded). The embed job works through the
          queue nightly; until a page is embedded it is found by its words only, not by meaning.
        </Notice>
      )}

      <div className="tiles">
        <Tile
          label="Indexed pages"
          value={indexed.toLocaleString()}
          foot={
            Object.keys(tiers).length
              ? Object.entries(tiers)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([t, n]) => `${t} ${num(n).toLocaleString()}`)
                .join(' · ')
              : 'no pages indexed'
          }
        />
        <Tile
          label="Indexed, last 24h"
          value={num(data.indexed_24h).toLocaleString()}
          foot="pages fetched or changed"
        />
        <Tile
          label="Safety queue"
          value={safety.toLocaleString()}
          state={safety > 0 ? 'warn' : 'good'}
          foot={safety > 0
            ? <Link href="/admin/safety">review — 48h target</Link>
            : 'nothing awaiting review'}
        />
        <Tile
          label="Embedding backlog"
          value={backlog.toLocaleString()}
          state={backlog > 0 ? 'warn' : 'good'}
          foot={backlog > 0 ? 'no semantic matching until cleared' : 'fully embedded'}
        />
        <Tile
          label="Failing domains"
          value={failing.toLocaleString()}
          state={failing > 0 ? 'bad' : 'good'}
          foot="3+ consecutive crawl failures"
        />
        <Tile
          label="Zone A eligible"
          value={num(data.zone_a_domains).toLocaleString()}
          foot={`${num(data.pending_domains).toLocaleString()} pending verification`}
        />
        <Tile
          label="Webhooks, 24h"
          value={webhooks.toLocaleString()}
          state={webhookFailures > 0 ? 'warn' : undefined}
          foot={webhooks === 0
            ? 'none received'
            : `${webhookFailures} failed · ${pct((webhooks - webhookFailures) / webhooks)} success`}
        />
        <Tile
          label="p95 search latency"
          value={p95 ? `${Math.round(p95)}ms` : '—'}
          // §13.10 budgets p95 at 400ms.
          state={p95 === 0 ? undefined : p95 > 400 ? 'bad' : 'good'}
          foot="24h · §13.10 budget is 400ms"
        />
        <Tile
          label="Cache hit rate"
          value={data.cache_hit_rate === null ? '—' : pct(num(data.cache_hit_rate))}
          foot="24h"
        />
        <Tile
          label="Zone A coverage rate"
          value={data.zone_a_empty_rate === null ? '—' : pct(1 - emptyRate)}
          state={emptyRate > 0.5 ? 'warn' : undefined}
          foot={`7d · ${data.zone_a_empty_rate === null ? '—' : pct(emptyRate)} of searches found nothing from Jubilee`}
        />
        <Tile
          label="Zero-result searches"
          value={num(data.zero_result_queries_7d).toLocaleString()}
          foot={<Link href="/admin/analytics">7d · writing assignments</Link>}
        />
      </div>

      <Panel title="Zone A versus Zone B" note="click share, last 30 days">
        {ctr && ctr.zones.length > 0 ? (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Zone</th>
                  <th className="numCell">Impressions</th>
                  <th className="numCell">Clicks</th>
                  <th className="numCell">CTR</th>
                </tr>
              </thead>
              <tbody>
                {ctr.zones.map((z) => (
                  <tr key={z.zone}>
                    <td><strong>{z.zone === 'A' ? 'A — From Jubilee' : 'B — Wider web'}</strong></td>
                    <td className="numCell">{num(z.impressions).toLocaleString()}</td>
                    <td className="numCell">{num(z.clicks).toLocaleString()}</td>
                    <td className="numCell">{pct(num(z.ctr))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            No impressions recorded yet. This fills in once searches are being clicked.
          </div>
        )}
      </Panel>

      <Panel title="Top queries" note={<>last 7 days · <Link href="/admin/analytics">full analytics</Link></>}>
        {overview && overview.top_queries.length > 0 ? (
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Query</th><th className="numCell">Times</th><th className="numCell">Zone A empty</th></tr>
              </thead>
              <tbody>
                {overview.top_queries.slice(0, 10).map((q) => (
                  <tr key={q.normalized}>
                    <td className="wrapCell mono"><strong>{q.normalized}</strong></td>
                    <td className="numCell">{num(q.times).toLocaleString()}</td>
                    <td className="numCell" style={{ color: num(q.zone_a_empty) > 0 ? 'var(--a-warn)' : undefined }}>{num(q.zone_a_empty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No searches recorded in the last 7 days.</div>
        )}
      </Panel>
    </>
  );
}
