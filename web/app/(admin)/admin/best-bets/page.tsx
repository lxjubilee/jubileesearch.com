import type { Metadata } from 'next';
import { getBestBets, getBestBetAudit, num, AdminRequestFailed } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import {
  createBestBetAction, deactivateBestBetAction, updateBestBetAction, moveBestBetAction,
} from '@/lib/admin-actions';
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
// the next request and no cache invalidation is involved.
//
// Reordering is a pair of arrows rather than drag-and-drop: it works without
// JavaScript, it is one server round trip, and the audit log records each move
// as an update with before and after.

export const metadata: Metadata = { title: 'Best bets' };

type Bet = Awaited<ReturnType<typeof getBestBets>>['best_bets'][number];

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

  let audit: Awaited<ReturnType<typeof getBestBetAudit>>['entries'] = [];
  try { audit = (await getBestBetAudit(50)).entries; } catch { /* the log is an extra */ }

  const active = data.best_bets.filter((b) => b.active);
  const inactive = data.best_bets.filter((b) => !b.active);
  const order = active.map((b) => b.id).join(',');

  return (
    <>
      <PageHead
        title="Best bets"
        sub="Curated answers pinned above Zone A for an exact query. They bypass the result cache, so a change is live on the very next search."
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

      <Panel title="Active" note={`${active.length} live · arrows reorder`}>
        {active.length === 0 ? (
          <Empty>No active best bets.</Empty>
        ) : (
          <BetTable bets={active} admin={admin} order={order} live />
        )}
      </Panel>

      <Panel title="Inactive" note={`${inactive.length}`}>
        {inactive.length === 0 ? <Empty>None.</Empty> : <BetTable bets={inactive} admin={admin} order="" />}
      </Panel>

      <Panel title="Audit log" note="most recent 50 · every create, update, move and deactivate">
        {audit.length === 0 ? <Empty>Nothing has been changed yet.</Empty> : (
          <div className="scroll">
            <table>
              <thead>
                <tr><th>When</th><th>Action</th><th>Bet</th><th>Actor</th><th className="wrapCell">Change</th></tr>
              </thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.id}>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(e.at)}</td>
                    <td><Pill tone={e.action === 'deactivate' ? 'bad' : e.action === 'create' ? 'good' : 'accent'}>{e.action}</Pill></td>
                    <td className="mono">#{e.best_bet_id} {String(e.after_state?.pattern ?? e.before_state?.pattern ?? '')}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{e.actor}</td>
                    <td className="wrapCell" style={{ fontSize: 12, color: 'var(--a-ink-dim)' }}>{diff(e.before_state, e.after_state)}</td>
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

const WATCHED = ['pattern', 'match_type', 'lang', 'target_url', 'title_override', 'blurb', 'position', 'starts_at', 'ends_at', 'active'];

function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!before) return 'created';
  if (!after) return 'deleted';
  const parts: string[] = [];
  for (const k of WATCHED) {
    const a = before[k] ?? null; const b = after[k] ?? null;
    if (String(a) !== String(b)) parts.push(`${k}: ${a ?? '—'} → ${b ?? '—'}`);
  }
  return parts.join(' · ') || 'no visible change';
}

/** The rendered block, as the results page draws it: title, URL, blurb. */
function Preview({ b }: { b: Bet }) {
  return (
    <div style={{ border: '1px solid var(--a-line)', borderLeft: '3px solid var(--a-accent)', borderRadius: 6, padding: '8px 12px', background: 'var(--a-panel-2)', maxWidth: 420 }}>
      <div style={{ fontSize: 10.5, letterSpacing: .8, textTransform: 'uppercase', color: 'var(--a-accent)', fontWeight: 600 }}>Best bet</div>
      <div style={{ fontWeight: 600, marginTop: 2 }}>{b.title_override || b.target_url}</div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--a-ink-faint)' }}>{b.target_url}</div>
      {b.blurb && <div style={{ fontSize: 12.5, color: 'var(--a-ink-dim)', marginTop: 4 }}>{b.blurb}</div>}
    </div>
  );
}

function Schedule({ b }: { b: Bet }) {
  if (!b.starts_at && !b.ends_at) return <span className="sub">always</span>;
  const now = Date.now();
  const live = (!b.starts_at || Date.parse(b.starts_at) <= now) && (!b.ends_at || Date.parse(b.ends_at) > now);
  return (
    <>
      <Pill tone={live ? 'good' : 'warn'}>{live ? 'in window' : 'outside window'}</Pill>
      <div className="mono" style={{ fontSize: 11, color: 'var(--a-ink-faint)', marginTop: 3 }}>
        {b.starts_at ? when(b.starts_at) : '…'} → {b.ends_at ? when(b.ends_at) : '…'}
      </div>
    </>
  );
}

const local = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');

function BetTable({ bets, admin, order, live = false }: { bets: Bet[]; admin: boolean; order: string; live?: boolean }) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th className="numCell">Pos</th><th>Match</th><th className="wrapCell">Preview</th>
            <th>Schedule</th><th>Lang</th><th>Created by</th><th className="numCell">Rev</th>
            {admin && <th />}
          </tr>
        </thead>
        <tbody>
          {bets.map((b, i) => (
            <BetRow key={b.id} b={b} admin={admin} order={order} live={live} first={i === 0} last={i === bets.length - 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BetRow(
  { b, admin, order, live, first, last }:
  { b: Bet; admin: boolean; order: string; live: boolean; first: boolean; last: boolean },
) {
  const cols = admin ? 8 : 7;
  return (
    <>
      <tr>
        <td className="numCell">{num(b.position)}</td>
        <td>
          <Pill tone="accent">{b.match_type}</Pill>{' '}
          <span className="mono">{b.pattern}</span>
        </td>
        <td className="wrapCell"><Preview b={b} /></td>
        <td><Schedule b={b} /></td>
        <td>{b.lang ?? 'all'}</td>
        <td className="mono" style={{ fontSize: 11.5 }}>{b.created_by ?? '—'}<br />{when(b.created_at)}</td>
        <td className="numCell">{num(b.revisions)}</td>
        {admin && (
          <td>
            <div className="actions">
              {live && !first && (
                <ActionForm action={moveBestBetAction}>
                  <input type="hidden" name="id" value={b.id} />
                  <input type="hidden" name="dir" value="up" />
                  <input type="hidden" name="order" value={order} />
                  <SubmitButton>▲</SubmitButton>
                </ActionForm>
              )}
              {live && !last && (
                <ActionForm action={moveBestBetAction}>
                  <input type="hidden" name="id" value={b.id} />
                  <input type="hidden" name="dir" value="down" />
                  <input type="hidden" name="order" value={order} />
                  <SubmitButton>▼</SubmitButton>
                </ActionForm>
              )}
              {live && (
                <ActionForm action={deactivateBestBetAction}>
                  <input type="hidden" name="id" value={b.id} />
                  <SubmitButton tone="danger" confirm={`Deactivate the best bet for "${b.pattern}"?`}>Deactivate</SubmitButton>
                </ActionForm>
              )}
            </div>
          </td>
        )}
      </tr>
      {admin && (
        <tr>
          <td colSpan={cols} style={{ padding: 0, borderTop: 0 }}>
            <details className="rowDetails">
              <summary>Edit “{b.pattern}”{live ? '' : ' · reactivate'}</summary>
              <div className="panelBody">
                <ActionForm action={updateBestBetAction}>
                  <input type="hidden" name="id" value={b.id} />
                  <input type="hidden" name="active_present" value="1" />
                  <div className="formGrid">
                    <div>
                      <label htmlFor={`bb-type-${b.id}`}>Match type</label>
                      <select id={`bb-type-${b.id}`} name="match_type" defaultValue={b.match_type}>
                        <option value="exact">exact</option><option value="phrase">phrase</option><option value="regex">regex</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`bb-pat-${b.id}`}>Pattern</label>
                      <input id={`bb-pat-${b.id}`} name="pattern" type="text" defaultValue={b.pattern} required />
                    </div>
                    <div>
                      <label htmlFor={`bb-lang-${b.id}`}>Language</label>
                      <input id={`bb-lang-${b.id}`} name="lang" type="text" defaultValue={b.lang ?? ''} placeholder="blank = all" />
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label htmlFor={`bb-url-${b.id}`}>Target URL</label>
                      <input id={`bb-url-${b.id}`} name="target_url" type="url" defaultValue={b.target_url} required />
                    </div>
                    <div>
                      <label htmlFor={`bb-title-${b.id}`}>Title override</label>
                      <input id={`bb-title-${b.id}`} name="title_override" type="text" defaultValue={b.title_override ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`bb-pos-${b.id}`}>Position</label>
                      <input id={`bb-pos-${b.id}`} name="position" type="number" min={1} defaultValue={num(b.position)} />
                    </div>
                    <div>
                      <label htmlFor={`bb-start-${b.id}`}>Starts (UTC)</label>
                      <input id={`bb-start-${b.id}`} name="starts_at" type="datetime-local" defaultValue={local(b.starts_at)} />
                    </div>
                    <div>
                      <label htmlFor={`bb-end-${b.id}`}>Ends (UTC)</label>
                      <input id={`bb-end-${b.id}`} name="ends_at" type="datetime-local" defaultValue={local(b.ends_at)} />
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label htmlFor={`bb-blurb-${b.id}`}>Blurb (240 characters)</label>
                      <input id={`bb-blurb-${b.id}`} name="blurb" type="text" maxLength={240} defaultValue={b.blurb ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`bb-active-${b.id}`}>
                        <input id={`bb-active-${b.id}`} name="active" type="checkbox" defaultChecked={b.active} style={{ width: 'auto', marginRight: 6 }} />
                        Active
                      </label>
                    </div>
                    <div><SubmitButton tone="primary">Save</SubmitButton></div>
                  </div>
                </ActionForm>
              </div>
            </details>
          </td>
        </tr>
      )}
    </>
  );
}
