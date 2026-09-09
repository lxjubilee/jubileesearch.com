import type { Metadata } from 'next';
import Link from 'next/link';
import { getZoneCtr, getZeroResults, num, AdminRequestFailed } from '@/lib/admin';
import { PageHead, Panel, Pill, Empty, Notice, LoadFailed, when, pct } from '@/components/admin/ui';

// Screen 8: search analytics (§15).
//
// "Query volume by intent, Zone A versus Zone B click share, click-through rate
// by zone and position, zero-result queries, Zone A empty-state rate, query
// language distribution, lexicon concept hit rates."
//
// The Zone A / Zone B comparison is the tripwire from the risk register: "If
// Zone A CTR falls below Zone B CTR, the floor is wrong and must be raised
// immediately." It is first on the page and states the consequence, so it
// cannot be read as an interesting statistic.
//
// The zero-result list is the same data the writing team acts on -- §10.3 makes
// a gap a writing assignment before it is a crawl target -- and the same list a
// reader adds to from the /suggest form.

export const metadata: Metadata = { title: 'Search analytics' };

export default async function AnalyticsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const days = Math.min(90, Math.max(1, Number(one(params.days) || 7)));

  let ctr = null;
  let ctrFailure = '';
  try { ctr = await getZoneCtr(); } catch (err) {
    ctrFailure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  let zero = null;
  let zeroFailure = '';
  try { zero = await getZeroResults(days); } catch (err) {
    zeroFailure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  const byIntent = new Map<string, number>();
  const byLang = new Map<string, number>();
  for (const q of zero?.queries ?? []) {
    const intent = q.intent ?? 'unknown';
    const lang = q.lang ?? 'unknown';
    byIntent.set(intent, (byIntent.get(intent) ?? 0) + num(q.times));
    byLang.set(lang, (byLang.get(lang) ?? 0) + num(q.times));
  }

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
              <thead>
                <tr>
                  <th>Zone</th><th className="numCell">Impressions</th>
                  <th className="numCell">Clicks</th><th className="numCell">CTR</th>
                </tr>
              </thead>
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

      <Panel
        title="Zero-result searches"
        note={
          <>
            {[7, 30, 90].map((d) => (
              <Link
                key={d}
                href={`/admin/analytics?days=${d}`}
                style={{ marginLeft: 10, color: d === days ? 'var(--a-accent)' : 'var(--a-ink-faint)' }}
              >
                {d}d
              </Link>
            ))}
          </>
        }
      >
        {zeroFailure ? (
          <div className="panelBody"><LoadFailed what="Zero-result searches" detail={zeroFailure} /></div>
        ) : (zero?.queries.length ?? 0) === 0 ? (
          <Empty>Nothing came back empty in the last {days} days.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Query</th><th>Lang</th><th>Intent</th>
                  <th className="numCell">Times</th><th>Last seen</th>
                </tr>
              </thead>
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

      {/* Distributions are computed from the zero-result rows the API returned,
          so they describe *failed* searches only. Labelled that way rather than
          presented as overall query volume, which the API does not expose. */}
      <Panel title="Failed searches by intent" note={`last ${days} days`}>
        {byIntent.size === 0 ? <Empty>Nothing to summarise.</Empty> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Intent</th><th className="numCell">Searches</th></tr></thead>
              <tbody>
                {[...byIntent.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <tr key={k}><td><Pill>{k}</Pill></td><td className="numCell">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Failed searches by language" note={`last ${days} days`}>
        {byLang.size === 0 ? <Empty>Nothing to summarise.</Empty> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Language</th><th className="numCell">Searches</th></tr></thead>
              <tbody>
                {[...byLang.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <tr key={k}><td className="mono">{k}</td><td className="numCell">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="sub">
        Not yet on this screen: total query volume by intent (as opposed to failed-search volume),
        click-through by <em>position</em>, and lexicon concept hit rates. Each needs an endpoint
        the admin API does not have; deriving them from the zero-result sample would describe a
        different population and read as though it described all searches.
      </p>
    </>
  );
}
