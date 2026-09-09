import type { Metadata } from 'next';
import { getSafetyQueue, num, AdminRequestFailed } from '@/lib/admin';
import { isAdmin } from '@/lib/session';
import { getSession } from '@/lib/session';
import { decideSafetyAction } from '@/lib/admin-actions';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Pill, Empty, LoadFailed, ago, when } from '@/components/admin/ui';

// Screen 6: safety queue (§15).
//
// "Pending reviews sorted by age, page text, machine verdict and reasons, and
// approve, reject, and block-domain actions."
//
// §17 Security: "Fetched HTML never rendered in the admin console without
// sanitization." The engine sends `body_excerpt` as extracted plain text, and
// this page renders it as text -- inside {} so React escapes it, in a monospace
// block that looks like the quoted evidence it is. There is no
// dangerouslySetInnerHTML anywhere in the console and none should ever be added
// here: the whole point of this screen is to look at content nobody trusts yet.

export const metadata: Metadata = { title: 'Safety queue' };

export default async function SafetyPage() {
  const session = await getSession();
  const admin = isAdmin(session);

  let data;
  let failure = '';
  try {
    data = await getSafetyQueue();
  } catch (err) {
    failure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  if (!data) {
    return (
      <>
        <PageHead title="Safety queue" />
        <LoadFailed what="The safety queue" detail={failure} />
      </>
    );
  }

  const { queue, target_latency_hours: target } = data;
  const overdue = queue.filter((r) => num(r.age_hours) > target).length;

  return (
    <>
      <PageHead
        title="Safety queue"
        sub={`Pages held for human review, oldest first. The target is ${target} hours; a page stays below the fold until it is cleared.`}
      />

      {overdue > 0 && (
        <div className="notice" data-tone="warn">
          <strong>{overdue} review{overdue === 1 ? ' is' : 's are'} past the {target}-hour target.</strong>{' '}
          Nothing is being served from them meanwhile, so the cost is coverage rather than safety.
        </div>
      )}

      {!admin && (
        <div className="notice">
          You are signed in with <code>search_viewer</code>. You can read the queue; the verdict
          buttons are hidden because the engine would refuse them.
        </div>
      )}

      {queue.length === 0 ? (
        <Panel><Empty>Nothing is waiting for review.</Empty></Panel>
      ) : (
        queue.map((r) => {
          const age = num(r.age_hours);
          const reasons = Array.isArray(r.machine_reasons)
            ? (r.machine_reasons as unknown[]).map(String)
            : r.machine_reasons && typeof r.machine_reasons === 'object'
              ? Object.entries(r.machine_reasons as Record<string, unknown>)
                .map(([k, v]) => `${k}: ${String(v)}`)
              : [];

          return (
            <Panel
              key={r.id}
              title={r.title ?? r.url}
              note={
                <>
                  <Pill tone={age > target ? 'bad' : 'neutral'}>{ago(age)} old</Pill>{' '}
                  <Pill>{r.tier}</Pill>{' '}
                  <Pill tone={r.safety_verdict === 'unsafe' ? 'bad' : 'neutral'}>
                    {r.safety_verdict ?? 'unclassified'}
                  </Pill>
                </>
              }
            >
              <div className="panelBody">
                <div className="mono" style={{ marginBottom: 10, wordBreak: 'break-all' }}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer nofollow">{r.url}</a>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 12, fontSize: 12.5, color: 'var(--a-ink-dim)' }}>
                  <span>Host <strong className="mono">{r.host}</strong></span>
                  <span>Machine score <strong className="mono">
                    {r.machine_score === null ? '—' : num(r.machine_score).toFixed(2)}
                  </strong></span>
                  <span>Queued {when(r.created_at)}</span>
                </div>

                {reasons.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    {reasons.map((reason) => (
                      <span key={reason} style={{ marginRight: 6 }}>
                        <Pill tone="warn">{reason}</Pill>
                      </span>
                    ))}
                  </div>
                )}

                {r.notes && (
                  <p style={{ fontSize: 13, color: 'var(--a-ink-dim)', margin: '0 0 12px' }}>
                    <strong>Note:</strong> {r.notes}
                  </p>
                )}

                {/* Plain text, escaped by React. Never markup -- see the header. */}
                <div className="excerpt">{r.body_excerpt ?? '(no text was extracted from this page)'}</div>

                {admin && (
                  <ActionForm action={decideSafetyAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <div style={{ marginTop: 14, marginBottom: 10 }}>
                      <label htmlFor={`notes-${r.id}`}>Reviewer note (recorded with the verdict)</label>
                      <textarea id={`notes-${r.id}`} name="notes" rows={2} />
                    </div>
                    <div className="actions">
                      <SubmitButton tone="good" name="verdict" value="approve">
                        Approve — safe
                      </SubmitButton>
                      <SubmitButton
                        tone="danger"
                        name="verdict"
                        value="reject"
                        confirm={`Reject this page?\n\n${r.url}\n\nIt leaves the index.`}
                      >
                        Reject page
                      </SubmitButton>
                      <SubmitButton
                        tone="danger"
                        name="verdict"
                        value="block_domain"
                        confirm={`Block ${r.host} entirely?\n\nEvery page from this domain is purged from the index immediately. This is not limited to the page under review.`}
                      >
                        Block {r.host}
                      </SubmitButton>
                    </div>
                  </ActionForm>
                )}
              </div>
            </Panel>
          );
        })
      )}
    </>
  );
}
