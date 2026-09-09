import type { Metadata } from 'next';
import { getRanking, num, AdminRequestFailed } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import { updateRankingAction, revertRankingAction } from '@/lib/admin-actions';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Empty, LoadFailed, when } from '@/components/admin/ui';

// Screen 9: ranking controls (§15).
//
// "Live editing of all weights in Section 13.6, Zone A coverage thresholds, and
// cache time-to-live values, with a change log and one-click revert."
//
// Two things make this screen safe to use, and both are the engine's doing
// rather than this page's: every write is recorded in `ranking_config_audit`
// with the actor, and the UPDATE trigger bumps the index version, so no result
// is ever served under a weight that has been changed out from under it.
//
// The revert is one click because the audit row already holds the old value.
// There is no "undo stack" here to get out of step with the database.

export const metadata: Metadata = { title: 'Ranking controls' };

// §13.6 groups these; the keys are flat in the table, so the grouping lives here.
function group(key: string): string {
  if (key.startsWith('w_')) return 'Ranking weights (§13.6)';
  if (key.includes('coverage') || key.startsWith('zone_a')) return 'Zone A coverage thresholds';
  if (key.includes('ttl') || key.includes('cache')) return 'Cache lifetimes';
  return 'Other';
}

export default async function RankingPage() {
  const session = await getSession();
  const admin = isAdmin(session);

  let data;
  let failure = '';
  try {
    data = await getRanking();
  } catch (err) {
    failure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  if (!data) {
    return (
      <>
        <PageHead title="Ranking controls" />
        <LoadFailed what="The ranking configuration" detail={failure} />
      </>
    );
  }

  const groups = new Map<string, typeof data.config>();
  for (const row of data.config) {
    const g = group(row.key);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(row);
  }

  return (
    <>
      <PageHead
        title="Ranking controls"
        sub="Live weights, thresholds and cache lifetimes. Every change is recorded with who made it, and bumps the index version so nothing is served under the old values."
      />

      {!admin && (
        <div className="notice">
          <code>search_viewer</code> can read these values but not change them.
        </div>
      )}

      {admin ? (
        <ActionForm action={updateRankingAction}>
          {[...groups.entries()].map(([name, rows]) => (
            <Panel key={name} title={name} note={`${rows.length} keys`}>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Key</th><th className="wrapCell">What it does</th>
                      <th style={{ width: 140 }}>Value</th><th>Last changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td className="mono"><strong>{r.key}</strong></td>
                        <td className="wrapCell" style={{ color: 'var(--a-ink-dim)' }}>
                          {r.description ?? '—'}
                        </td>
                        <td>
                          {/* The previous value rides along so the action can send
                              only what actually changed. */}
                          <input type="hidden" name={`was:${r.key}`} value={String(r.value ?? '')} />
                          <input
                            type="number"
                            step="any"
                            name={`key:${r.key}`}
                            defaultValue={String(r.value ?? '')}
                            aria-label={r.key}
                          />
                        </td>
                        <td style={{ fontSize: 11.5, color: 'var(--a-ink-faint)' }}>
                          {r.updated_by ? <>{r.updated_by}<br />{when(r.updated_at)}</> : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ))}

          <div className="actions" style={{ marginBottom: 24 }}>
            <SubmitButton
              tone="primary"
              confirm={'Apply these ranking changes?\n\nThe index version is bumped, so every cached result is discarded and the next search uses the new weights.'}
            >
              Apply changes
            </SubmitButton>
            <span className="sub">Only the fields you actually changed are written.</span>
          </div>
        </ActionForm>
      ) : (
        [...groups.entries()].map(([name, rows]) => (
          <Panel key={name} title={name} note={`${rows.length} keys`}>
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>Key</th><th className="wrapCell">What it does</th><th className="numCell">Value</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td className="mono">{r.key}</td>
                      <td className="wrapCell" style={{ color: 'var(--a-ink-dim)' }}>{r.description ?? '—'}</td>
                      <td className="numCell">{String(r.value ?? '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ))
      )}

      <Panel title="Change log" note="most recent 50">
        {data.recent_changes.length === 0 ? (
          <Empty>No ranking changes have been made.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th><th>Key</th>
                  <th className="numCell">From</th><th className="numCell">To</th>
                  <th>Who</th>{admin && <th>Revert</th>}
                </tr>
              </thead>
              <tbody>
                {data.recent_changes.map((c, i) => (
                  <tr key={`${c.key}-${c.at}-${i}`}>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(c.at)}</td>
                    <td className="mono">{c.key}</td>
                    <td className="numCell">{String(c.old_value ?? '—')}</td>
                    <td className="numCell"><strong>{String(c.new_value ?? '—')}</strong></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{c.actor ?? '—'}</td>
                    {admin && (
                      <td>
                        {c.old_value === null ? '—' : (
                          <ActionForm action={revertRankingAction}>
                            <input type="hidden" name="key" value={c.key} />
                            <input type="hidden" name="to" value={String(c.old_value)} />
                            <SubmitButton confirm={`Revert ${c.key} to ${c.old_value}?`}>
                              Revert
                            </SubmitButton>
                          </ActionForm>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
