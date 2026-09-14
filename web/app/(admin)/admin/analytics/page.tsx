import type { Metadata } from 'next';
import Link from 'next/link';
import { getZoneCtr, getZeroResults, getAnalyticsOverview, getContentGap, getContentGapCsv, num, AdminRequestFailed } from '@/lib/admin';
import { PageHead, Panel, Pill, Empty, Notice, LoadFailed, when, pct } from '@/components/admin/ui';

// Screen 8: search analytics (§15).
//
// "Query volume by intent, Zone A versus Zone B click share, click-through rate
// by zone and position, zero-result queries, Zone A empty-state rate, query
// language distribution, lexicon concept hit rates."
//
// The Zone A / Zone B comparison is the tripwire from the risk register: "If
// Zone A CTR falls below Zone B CTR, the floor is wrong and must be raised
// immediately." It is first on the page and states the consequence.
//
// Everything is aggregate. No query here is tied to a person (§17).

export const metadata: Metadata = { title: 'Search analytics' };

export default async function AnalyticsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const days = Math.min(90, Math.max(1, Number(one(params.days) || 7)));

  let ctr = null; let ctrFailure = '';
  try { ctr = await getZoneCtr(); } catch (err) { ctrFailure = err instanceof AdminRequestFailed ? err.message : String(err); }

  let zero = null; let zeroFailure = '';
  try { zero = await getZeroResults(days); } catch (err) { zeroFailure = err instanceof AdminRequestFailed ? err.message : String(err); }

  let overview = null; let overviewFailure = '';
  try { overview = await getAnalyticsOverview(days); } catch (err) { overviewFailure = err instanceof AdminRequestFailed ? err.message : String(err); }

  let gap = null; let gapCsv = '';
  try { gap = await getContentGap(days); gapCsv = (await getContentGapCsv(days)).csv; } catch { /* the report is an extra */ }

  const totalSearches = (overview?.by_intent ?? []).reduce((n, r) => n + num(r.searches), 0);
  const totalZero = (overview?.by_intent ?? []).reduce((n, r) => n + num(r.zero_results), 0);
  const totalLang = (overview?.by_language ?? []).reduce((n, r) => n + num(r.searches), 0);

  const range = (
    <>
      {[7, 30, 90].map((d) => (
        <Link key={d} href={`/admin/analytics?days=${d}`}
              style={{ marginLeft: 10, color: d === days ? 'var(--a-accent)' : 'var(--a-ink-faint)' }}>
          {d}d
        </Link>
      ))}
    </>
  );

  return (
    <>
      <PageHead
        title="Search analytics"
        sub="What readers asked for and what they got. Counts are aggregate — no query here is tied to a person (§17)."
      />

      {ctr?.zone_a_below_zone_b && (
        <Notice tone="bad">
          <strong>Zone A click-through has fallen below Zone B.</strong> {ctr.note}{' '}
          <Link href="/admin/ranking">Open ranking controls</Link>.
        </Notice>
      )}

      <Panel title="Zone A versus Zone B" note="click share, last 30 days">
        {ctrFailure ? (
          <div className="panelBody"><LoadFailed what="Click share" detail={ctrFailure} /></div>
        ) : (ctr?.zones.length ?? 0) === 0 ? (
          <Empty>No impressions recorded yet.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Zone</th><th className="numCell">Impressions</th><th className="numCell">Clicks</th><th className="numCell">CTR</th></tr></thead>
              <tbody>
                {ctr!.zones.map((z) => (
                  <tr key={z.zone}>
                    <td><strong>{z.zone === 'A' ? 'A — From Jubilee' : 'B — Wider web'}</strong></td>
                    <td className="numCell">{num(z.impressions).toLocaleString()}</td>
                    <td className="numCell">{num(z.clicks).toLocaleString()}</td>
                    <td className="numCell"><strong>{pct(num(z.ctr))}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Query volume by intent" note={<>{totalSearches.toLocaleString()} searches, {totalZero.toLocaleString()} empty {range}</>}>
        {overviewFailure ? (
          <div className="panelBody"><LoadFailed what="The overview" detail={overviewFailure} /></div>
        ) : (overview?.by_intent.length ?? 0) === 0 ? (
          <Empty>No searches in the last {days} days.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Intent</th><th className="numCell">Searches</th><th className="numCell">Share</th><th className="numCell">Zero-result</th><th className="numCell">Empty rate</th></tr></thead>
              <tbody>
                {overview!.by_intent.map((r) => (
                  <tr key={r.intent}>
                    <td><Pill>{r.intent}</Pill></td>
                    <td className="numCell">{num(r.searches).toLocaleString()}</td>
                    <td className="numCell">{pct(num(r.searches) / Math.max(1, totalSearches))}</td>
                    <td className="numCell">{num(r.zero_results).toLocaleString()}</td>
                    <td className="numCell" style={{ color: num(r.zero_results) / Math.max(1, num(r.searches)) > 0.2 ? 'var(--a-warn)' : undefined }}>
                      {pct(num(r.zero_results) / Math.max(1, num(r.searches)))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Click-through by zone and position" note={`top 10 positions, last ${days} days`}>
        {(overview?.ctr_by_position.length ?? 0) === 0 ? (
          <Empty>No impressions in the last {days} days.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Zone</th><th className="numCell">Position</th><th className="numCell">Impressions</th><th className="numCell">Clicks</th><th className="numCell">CTR</th></tr></thead>
              <tbody>
                {overview!.ctr_by_position.map((r) => (
                  <tr key={`${r.zone}${r.position}`}>
                    <td><strong>{r.zone}</strong></td>
                    <td className="numCell">{r.position}</td>
                    <td className="numCell">{num(r.impressions).toLocaleString()}</td>
                    <td className="numCell">{num(r.clicks).toLocaleString()}</td>
                    <td className="numCell"><strong>{pct(num(r.ctr))}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Top queries" note={`last ${days} days · Zone A empty = searches that found nothing from Jubilee`}>
        {(overview?.top_queries.length ?? 0) === 0 ? <Empty>No searches yet.</Empty> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Query</th><th className="numCell">Times</th><th className="numCell">Zone A empty</th></tr></thead>
              <tbody>
                {overview!.top_queries.map((q) => (
                  <tr key={q.normalized}>
                    <td className="wrapCell mono"><strong>{q.normalized}</strong></td>
                    <td className="numCell">{num(q.times).toLocaleString()}</td>
                    <td className="numCell" style={{ color: num(q.zone_a_empty) > 0 ? 'var(--a-warn)' : undefined }}>{num(q.zone_a_empty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Zero-result searches" note={<>the writing team&rsquo;s list (§10.3) {range}</>}>
        {zeroFailure ? (
          <div className="panelBody"><LoadFailed what="Zero-result searches" detail={zeroFailure} /></div>
        ) : (zero?.queries.length ?? 0) === 0 ? (
          <Empty>Nothing came back empty in the last {days} days.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Query</th><th>Lang</th><th>Intent</th><th className="numCell">Times</th><th>Last seen</th></tr></thead>
              <tbody>
                {zero!.queries.map((q, i) => (
                  <tr key={`${q.normalized}-${i}`}>
                    <td className="wrapCell mono"><strong>{q.normalized}</strong></td>
                    <td>{q.lang ?? '—'}</td>
                    <td>{q.intent ? <Pill>{q.intent}</Pill> : '—'}</td>
                    <td className="numCell">{num(q.times)}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(q.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
        <Panel title="Query language distribution" note={`all searches, last ${days} days`}>
          {(overview?.by_language.length ?? 0) === 0 ? <Empty>Nothing to summarise.</Empty> : (
            <div className="scroll">
              <table>
                <thead><tr><th>Language</th><th className="numCell">Searches</th><th className="numCell">Share</th></tr></thead>
                <tbody>
                  {overview!.by_language.map((r) => (
                    <tr key={r.lang}>
                      <td className="mono">{r.lang}</td>
                      <td className="numCell">{num(r.searches).toLocaleString()}</td>
                      <td className="numCell">{pct(num(r.searches) / Math.max(1, totalLang))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Content-gap report" note={<>§16 · the writing team&rsquo;s weekly export, live for the last {days} days {range}</>}>
          {!gap ? <Empty>The report could not be built.</Empty> : (
            <div className="panelBody" style={{ display: 'grid', gap: 14 }}>
              <div className="sub" style={{ margin: 0 }}>
                {num(gap.totals.searches).toLocaleString()} searches · {num(gap.totals.zero_result).toLocaleString()} found nothing · {num(gap.totals.zone_a_empty).toLocaleString()} found nothing from Jubilee.
                Listed below: queries seen at least {gap.thresholds.min_times} times, and Zone A blocks shown at least {gap.thresholds.min_impressions} times with click-through under {pct(gap.thresholds.low_ctr_below)}.
                A weekly file lands in the reports directory on the server (<span className="mono">content-gap-latest.csv</span>).
              </div>
              {([['Nothing at all came back', gap.zero_result], ['The wider web answered, Jubilee did not', gap.zone_a_empty]] as const).map(([title, rows]) => (
                <div key={title}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{title} <span className="sub">({rows.length})</span></div>
                  {rows.length === 0 ? <div className="sub">None in this window.</div> : (
                    <div className="scroll">
                      <table>
                        <thead><tr><th>Query</th><th>Lang</th><th>Intent</th><th className="numCell">Times</th><th>Last seen</th></tr></thead>
                        <tbody>
                          {rows.map((q, i) => (
                            <tr key={`${q.query}-${i}`}>
                              <td className="wrapCell mono"><strong>{q.query}</strong></td>
                              <td>{q.lang ?? '—'}</td>
                              <td>{q.intent ? <Pill>{q.intent}</Pill> : '—'}</td>
                              <td className="numCell">{num(q.times)}</td>
                              <td className="mono" style={{ fontSize: 11.5 }}>{when(q.last_seen)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Zone A shown, not clicked <span className="sub">({gap.low_ctr.length})</span></div>
                {gap.low_ctr.length === 0 ? <div className="sub">None in this window.</div> : (
                  <div className="scroll">
                    <table>
                      <thead><tr><th>Query</th><th className="numCell">Impressions</th><th className="numCell">Clicks</th><th className="numCell">CTR</th></tr></thead>
                      <tbody>
                        {gap.low_ctr.map((q) => (
                          <tr key={q.query}>
                            <td className="wrapCell mono"><strong>{q.query}</strong></td>
                            <td className="numCell">{num(q.impressions).toLocaleString()}</td>
                            <td className="numCell">{num(q.clicks).toLocaleString()}</td>
                            <td className="numCell">{pct(num(q.ctr))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              {gapCsv && (
                <details>
                  <summary className="sub" style={{ cursor: 'pointer' }}>CSV, ready to copy</summary>
                  <textarea readOnly value={gapCsv} rows={8} style={{ width: '100%', fontFamily: 'var(--a-mono)', fontSize: 11.5, marginTop: 8 }} />
                </details>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Lexicon concept hit rates" note={`concepts that expanded a search, last ${days} days`}>
          {(overview?.concept_hits.length ?? 0) === 0 ? <Empty>No concept expanded a search in this window.</Empty> : (
            <div className="scroll">
              <table>
                <thead><tr><th>Concept</th><th className="numCell">Searches</th><th className="numCell">Hit rate</th></tr></thead>
                <tbody>
                  {overview!.concept_hits.map((r) => (
                    <tr key={r.concept_key}>
                      <td className="mono"><Link href="/admin/lexicon">{r.concept_key}</Link></td>
                      <td className="numCell">{num(r.hits).toLocaleString()}</td>
                      <td className="numCell">{pct(num(r.hits) / Math.max(1, totalSearches))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
