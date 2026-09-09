import type { Metadata } from 'next';
import { getCandidates, num, AdminRequestFailed, type Candidate } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import { decideCandidateAction, nominateCandidateAction } from '@/lib/admin-actions';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Pill, Empty, LoadFailed, when } from '@/components/admin/ui';

// Screen 5: whitelist review (§15).
//
// "Nominated domains awaiting T2 approval, with sample pages and an approve or
// reject decision recorded with reviewer and timestamp."
//
// One queue, two very different decisions, and the screen says which is which
// before anyone clicks:
//
//   T2 -- an editorial judgement that puts a site into the index. §11.4: "T2
//         whitelist membership is a human editorial decision." Approving is the
//         decision itself.
//   T3 -- authorises a 20-page probe and nothing more. The domain enters at T0,
//         under a cap, and everything it yields still has to pass the safety
//         gates before any of it is servable (§10.2).
//
// Conflating those two would be the expensive mistake this screen exists to
// prevent, which is why the button text differs rather than saying "Approve".

export const metadata: Metadata = { title: 'Whitelist review' };

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'accent' | 'neutral'> = {
  nominated: 'warn',
  screened: 'accent',
  approved: 'good',
  promoted: 'good',
  rejected: 'bad',
  probing: 'accent',
};

export default async function CandidatesPage() {
  const session = await getSession();
  const admin = isAdmin(session);

  let data;
  let failure = '';
  try {
    data = await getCandidates();
  } catch (err) {
    failure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  if (!data) {
    return (
      <>
        <PageHead title="Whitelist review" />
        <LoadFailed what="The candidate queue" detail={failure} />
      </>
    );
  }

  const waiting = data.candidates.filter((c) => ['nominated', 'screened'].includes(c.status));
  const decided = data.candidates.filter((c) => !['nominated', 'screened'].includes(c.status));

  return (
    <>
      <PageHead
        title="Whitelist review"
        sub="Domains nominated for the open-web tiers. Every decision is recorded with the reviewer and the time."
      />

      {admin && (
        <Panel title="Nominate a domain" note="§10.2 — a person vouching bypasses the link threshold">
          <div className="panelBody">
            <ActionForm action={nominateCandidateAction}>
              <div className="formGrid">
                <div>
                  <label htmlFor="nom-host">Host</label>
                  <input id="nom-host" name="host" type="text" placeholder="example.org" required />
                </div>
                <div>
                  <label htmlFor="nom-tier">Target tier</label>
                  <select id="nom-tier" name="target_tier" defaultValue="T2">
                    <option value="T2">T2 — into the index on approval</option>
                    <option value="T3">T3 — probe only</option>
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="nom-note">Why (recorded with the nomination)</label>
                  <input id="nom-note" name="note" type="text" />
                </div>
                <div><SubmitButton tone="primary">Nominate</SubmitButton></div>
              </div>
            </ActionForm>
          </div>
        </Panel>
      )}

      <Panel title="Awaiting a decision" note={`${waiting.length} in the queue`}>
        {waiting.length === 0 ? (
          <Empty>Nothing is waiting for review.</Empty>
        ) : (
          waiting.map((c) => <CandidateRow key={c.id} c={c} admin={admin} />)
        )}
      </Panel>

      <Panel title="Decided" note="most recent first">
        {decided.length === 0 ? (
          <Empty>No decisions recorded yet.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Host</th><th>Tier</th><th>Status</th>
                  <th>Reviewer</th><th>When</th><th className="wrapCell">Notes</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.host}</td>
                    <td>{c.target_tier}</td>
                    <td><Pill tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Pill></td>
                    <td className="mono">{c.reviewed_by ?? '—'}</td>
                    <td className="mono">{when(c.reviewed_at)}</td>
                    <td className="wrapCell">{c.review_notes ?? '—'}</td>
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

function CandidateRow({ c, admin }: { c: Candidate; admin: boolean }) {
  const isT2 = c.target_tier === 'T2';
  const samples = c.sample_urls ?? [];

  return (
    <div className="panelBody" style={{ borderBottom: '1px solid var(--a-line-soft)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <strong className="mono" style={{ fontSize: 14 }}>{c.host}</strong>
        <Pill tone={isT2 ? 'accent' : 'neutral'}>{c.target_tier}</Pill>
        <Pill tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Pill>
        <span style={{ fontSize: 12, color: 'var(--a-ink-faint)' }}>
          {num(c.linking_domains)} linking domain{num(c.linking_domains) === 1 ? '' : 's'}
          {' · '}from {c.source}
          {' · '}first seen {when(c.first_seen_at)}
        </span>
      </div>

      {c.nomination_note && (
        <p style={{ fontSize: 13, color: 'var(--a-ink-dim)', margin: '0 0 8px' }}>
          <strong>Nominated by {c.nominated_by ?? 'unknown'}:</strong> {c.nomination_note}
        </p>
      )}

      {num(c.probe_pages) > 0 && (
        <p style={{ fontSize: 12.5, color: 'var(--a-ink-dim)', margin: '0 0 8px' }}>
          Probe so far: <strong>{num(c.probe_passed)}</strong> of{' '}
          <strong>{num(c.probe_pages)}</strong> pages passed the safety gates.
        </p>
      )}

      {samples.length > 0 && (
        <div style={{ margin: '0 0 10px' }}>
          <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--a-ink-faint)', marginBottom: 4 }}>
            Sample pages
          </div>
          <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {samples.slice(0, 5).map((u) => (
              <li key={u} style={{ wordBreak: 'break-all' }}>
                <a href={u} target="_blank" rel="noopener noreferrer nofollow">{u}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {admin && (
        // One form, two submit values -- the note belongs to the decision either
        // way, and a second <form> here would have to be a sibling rather than
        // nested, which HTML does not allow.
        <ActionForm action={decideCandidateAction}>
          <input type="hidden" name="id" value={c.id} />
          <input type="hidden" name="host" value={c.host} />
          <input type="hidden" name="target_tier" value={c.target_tier} />
          <div style={{ marginBottom: 10 }}>
            <label htmlFor={`rev-${c.id}`}>Decision note (recorded with the reviewer and time)</label>
            <input id={`rev-${c.id}`} name="notes" type="text" />
          </div>
          <div className="actions">
            <SubmitButton
              tone="good"
              name="decision"
              value="approve"
              confirm={isT2
                ? `Approve ${c.host} into T2?\n\nThis registers the domain and it becomes crawlable. It is the editorial decision that puts the site in the index.`
                : `Authorise a probe of ${c.host}?\n\nIt enters at T0 with a 20-page cap. Nothing from it is servable until the sample passes the safety gates.`}
            >
              {isT2 ? 'Approve into T2' : 'Authorise probe'}
            </SubmitButton>
            <SubmitButton
              tone="danger"
              name="decision"
              value="reject"
              confirm={`Reject ${c.host}?\n\nAnything a probe already fetched is purged.`}
            >
              Reject
            </SubmitButton>
          </div>
        </ActionForm>
      )}
    </div>
  );
}
