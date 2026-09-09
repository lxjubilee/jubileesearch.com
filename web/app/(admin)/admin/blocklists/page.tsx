import type { Metadata } from 'next';
import { getBlocklists, num, AdminRequestFailed } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import { addBlocklistEntryAction, deleteBlocklistEntryAction } from '@/lib/admin-actions';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Pill, Empty, LoadFailed, when } from '@/components/admin/ui';

// Screen 7: blocklists (§15). "Loaded sources, refresh status, manual entries."
//
// Only manual rules are editable. A rule that came from a loaded source belongs
// to that source and is replaced wholesale on the next refresh, so editing one
// here would be undone silently — which is exactly the kind of change that looks
// like it worked. The table shows them read-only for that reason.
//
// Severity is not decoration. The engine treats >= 100 as a hard block and 0 as
// an allow-override, and the guard in the API refuses a single-word keyword at
// hard severity, because one common word at severity 100 can empty the open web
// out of the index.

export const metadata: Metadata = { title: 'Blocklists' };

export default async function BlocklistsPage() {
  const session = await getSession();
  const admin = isAdmin(session);

  let data;
  let failure = '';
  try {
    data = await getBlocklists();
  } catch (err) {
    failure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  if (!data) {
    return (
      <>
        <PageHead title="Blocklists" />
        <LoadFailed what="The blocklists" detail={failure} />
      </>
    );
  }

  const totalEntries = data.sources.reduce((n, s) => n + num(s.entries), 0);

  return (
    <>
      <PageHead
        title="Blocklists"
        sub={`${totalEntries.toLocaleString()} rules across ${data.sources.length} source${data.sources.length === 1 ? '' : 's'}. Gate 1 checks a host against these before a single request is spent on it.`}
      />

      <Panel title="Sources" note="loaded lists and their last refresh">
        {data.sources.length === 0 ? (
          <Empty>No blocklist sources have been loaded. Run <code>npm run blocklists</code>.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Source</th><th className="numCell">Rules</th>
                  <th className="numCell">Hard</th><th className="numCell">Allow</th>
                  <th>Last load</th><th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={s.source}>
                    <td className="mono"><strong>{s.source}</strong></td>
                    <td className="numCell">{num(s.entries).toLocaleString()}</td>
                    <td className="numCell">{num(s.hard_blocks).toLocaleString()}</td>
                    <td className="numCell">{num(s.allow_overrides).toLocaleString()}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(s.last_load)}</td>
                    <td>
                      {s.last_outcome
                        ? <Pill tone={s.last_outcome === 'ok' ? 'good' : 'bad'}>{s.last_outcome}</Pill>
                        : '—'}
                      {s.last_error && (
                        <div style={{ fontSize: 11.5, color: 'var(--a-bad)' }}>{s.last_error}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {admin && (
        <Panel title="Add a manual rule" note="manual rules survive a source refresh">
          <div className="panelBody">
            <ActionForm action={addBlocklistEntryAction}>
              <div className="formGrid">
                <div>
                  <label htmlFor="bl-type">Match type</label>
                  <select id="bl-type" name="match_type" defaultValue="host">
                    <option value="host">host — exact hostname</option>
                    <option value="suffix">suffix — domain and subdomains</option>
                    <option value="regex">regex</option>
                    <option value="keyword">keyword</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="bl-pattern">Pattern</label>
                  <input id="bl-pattern" name="pattern" type="text" required />
                </div>
                <div>
                  <label htmlFor="bl-cat">Category</label>
                  <input id="bl-cat" name="category" type="text" placeholder="adult, malware…" />
                </div>
                <div>
                  <label htmlFor="bl-sev">Severity</label>
                  <select id="bl-sev" name="severity" defaultValue="100">
                    <option value="100">100 — hard block</option>
                    <option value="50">50 — review</option>
                    <option value="0">0 — allow override</option>
                  </select>
                </div>
                <div><SubmitButton tone="primary">Add rule</SubmitButton></div>
              </div>
            </ActionForm>
          </div>
        </Panel>
      )}

      <Panel title="Manual rules" note={`${data.manual_entries.length}`}>
        {data.manual_entries.length === 0 ? (
          <Empty>No manual rules.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Pattern</th><th>Type</th><th>Category</th>
                  <th className="numCell">Severity</th><th>Added</th>{admin && <th />}
                </tr>
              </thead>
              <tbody>
                {data.manual_entries.map((e) => (
                  <tr key={e.id}>
                    <td className="mono"><strong>{e.pattern}</strong></td>
                    <td>{e.match_type}</td>
                    <td>{e.category ?? '—'}</td>
                    <td className="numCell">
                      <Pill tone={num(e.severity) >= 100 ? 'bad' : num(e.severity) === 0 ? 'good' : 'warn'}>
                        {num(e.severity)}
                      </Pill>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(e.added_at)}</td>
                    {admin && (
                      <td>
                        <ActionForm action={deleteBlocklistEntryAction}>
                          <input type="hidden" name="id" value={e.id} />
                          <SubmitButton tone="danger" confirm={`Remove the rule for "${e.pattern}"?`}>
                            Remove
                          </SubmitButton>
                        </ActionForm>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Recent loads" note="last 20">
        {data.recent_loads.length === 0 ? (
          <Empty>No load has been recorded.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Source</th><th>Started</th>
                  <th className="numCell">Parsed</th><th className="numCell">Written</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_loads.map((l, i) => (
                  <tr key={`${l.source}-${l.started_at}-${i}`}>
                    <td className="mono">{l.source}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(l.started_at)}</td>
                    <td className="numCell">{num(l.entries_parsed).toLocaleString()}</td>
                    <td className="numCell">{num(l.entries_written).toLocaleString()}</td>
                    <td>
                      {l.outcome ? <Pill tone={l.outcome === 'ok' ? 'good' : 'bad'}>{l.outcome}</Pill> : '—'}
                      {l.error && <div style={{ fontSize: 11.5, color: 'var(--a-bad)' }}>{l.error}</div>}
                    </td>
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
