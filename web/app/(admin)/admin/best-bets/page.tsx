import type { Metadata } from 'next';
import { getBestBets, num, AdminRequestFailed } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import { createBestBetAction, deactivateBestBetAction } from '@/lib/admin-actions';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Pill, Empty, LoadFailed, when } from '@/components/admin/ui';

// Screen 4: best bets (§15).
//
// "Create, schedule, reorder, deactivate, with a preview of the rendered block
// and a full audit log."
//
// Acceptance criterion 17: "Best bets render above Zone A within 30 seconds of
// being created in the admin console." That is met by construction rather than
// by polling -- §13.7 has a best bet bypass the result cache, so it is live on
// the next request and no cache invalidation is involved. The note on the form
// says so, because an operator who does not know that will sit and refresh.

export const metadata: Metadata = { title: 'Best bets' };

export default async function BestBetsPage() {
  const session = await getSession();
  const admin = isAdmin(session);

  let data;
  let failure = '';
  try {
    data = await getBestBets();
  } catch (err) {
    failure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  if (!data) {
    return (
      <>
        <PageHead title="Best bets" />
        <LoadFailed what="Best bets" detail={failure} />
      </>
    );
  }

  const active = data.best_bets.filter((b) => b.active);
  const inactive = data.best_bets.filter((b) => !b.active);

  return (
    <>
      <PageHead
        title="Best bets"
        sub="Curated answers pinned above Zone A for an exact query. They bypass the result cache, so a new one is live on the very next search."
      />

      {admin && (
        <Panel title="Create a best bet" note="live on the next search — no cache to wait for">
          <div className="panelBody">
            <ActionForm action={createBestBetAction}>
              <div className="formGrid">
                <div>
                  <label htmlFor="bb-type">Match type</label>
                  <select id="bb-type" name="match_type" defaultValue="exact">
                    <option value="exact">exact</option>
                    <option value="phrase">phrase</option>
                    <option value="regex">regex</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="bb-pattern">Pattern</label>
                  <input id="bb-pattern" name="pattern" type="text" required placeholder="baptism" />
                </div>
                <div>
                  <label htmlFor="bb-lang">Language</label>
                  <input id="bb-lang" name="lang" type="text" placeholder="en (blank = all)" />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="bb-url">Target URL</label>
                  <input id="bb-url" name="target_url" type="url" required placeholder="https://jubileeverse.com/…" />
                </div>
                <div>
                  <label htmlFor="bb-title">Title override</label>
                  <input id="bb-title" name="title_override" type="text" />
                </div>
                <div>
                  <label htmlFor="bb-pos">Position</label>
                  <input id="bb-pos" name="position" type="number" min={1} defaultValue={1} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="bb-blurb">Blurb (240 characters)</label>
                  <input id="bb-blurb" name="blurb" type="text" maxLength={240} />
                </div>
                <div><SubmitButton tone="primary">Create</SubmitButton></div>
              </div>
            </ActionForm>
          </div>
        </Panel>
      )}

      <Panel title="Active" note={`${active.length} live`}>
        {active.length === 0 ? (
          <Empty>No active best bets.</Empty>
        ) : (
          <BetTable bets={active} admin={admin} showDeactivate />
        )}
      </Panel>

      <Panel title="Inactive" note={`${inactive.length}`}>
        {inactive.length === 0 ? <Empty>None.</Empty> : <BetTable bets={inactive} admin={false} />}
      </Panel>

      <p className="sub">
        Not yet on this screen: drag-to-reorder and scheduling windows. Position is editable on
        creation and <code>starts_at</code>/<code>ends_at</code> exist in the table, but the API
        has no update endpoint, so a change means deactivating and recreating.
      </p>
    </>
  );
}

function BetTable(
  { bets, admin, showDeactivate }:
  { bets: Awaited<ReturnType<typeof getBestBets>>['best_bets']; admin: boolean; showDeactivate?: boolean },
) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th className="numCell">Pos</th><th>Match</th><th className="wrapCell">Target</th>
            <th>Lang</th><th>Created by</th><th className="numCell">Revisions</th>
            {admin && showDeactivate && <th />}
          </tr>
        </thead>
        <tbody>
          {bets.map((b) => (
            <tr key={b.id}>
              <td className="numCell">{num(b.position)}</td>
              <td>
                <Pill tone="accent">{b.match_type}</Pill>{' '}
                <span className="mono">{b.pattern}</span>
              </td>
              <td className="wrapCell">
                <a href={b.target_url} target="_blank" rel="noopener noreferrer" className="mono">
                  {b.target_url}
                </a>
                {b.title_override && (
                  <div style={{ fontSize: 12, color: 'var(--a-ink-dim)' }}>{b.title_override}</div>
                )}
                {b.blurb && (
                  <div style={{ fontSize: 12, color: 'var(--a-ink-faint)' }}>{b.blurb}</div>
                )}
              </td>
              <td>{b.lang ?? 'all'}</td>
              <td className="mono" style={{ fontSize: 11.5 }}>
                {b.created_by ?? '—'}<br />{when(b.created_at)}
              </td>
              <td className="numCell">{num(b.revisions)}</td>
              {admin && showDeactivate && (
                <td>
                  <ActionForm action={deactivateBestBetAction}>
                    <input type="hidden" name="id" value={b.id} />
                    <SubmitButton
                      tone="danger"
                      confirm={`Deactivate the best bet for "${b.pattern}"?`}
                    >
                      Deactivate
                    </SubmitButton>
                  </ActionForm>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
