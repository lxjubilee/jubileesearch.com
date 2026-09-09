import type { Metadata } from 'next';
import { getDomains, num, AdminRequestFailed } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import { verifyDomainAction, purgeDomainAction, addDomainAction } from '@/lib/admin-actions';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Pill, Empty, LoadFailed, when } from '@/components/admin/ui';

// Screen 2: domains (§15).
//
// "List, filter, add, edit, bulk import, verify ownership, set ingest mode and
// source root, force reingest, pause, purge."
//
// Verification is the one control on this page that matters more than the rest
// put together. §8.2 makes it the *only* route into Zone A, and registration
// never grants it -- so a domain sitting at T1 with `zone_a_eligible` false is
// the normal state, not a fault. The column says so rather than leaving a blank
// cell to be read as an error.

export const metadata: Metadata = { title: 'Domains' };

const TIER_TONE: Record<string, 'good' | 'accent' | 'warn' | 'neutral'> = {
  T1: 'good', T2: 'accent', T3: 'warn', T0: 'neutral',
};

export default async function DomainsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const tier = one(params.tier);
  const status = one(params.status);

  const session = await getSession();
  const admin = isAdmin(session);

  let data;
  let failure = '';
  try {
    data = await getDomains({ tier: tier || undefined, status: status || undefined });
  } catch (err) {
    failure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  if (!data) {
    return (
      <>
        <PageHead title="Domains" />
        <LoadFailed what="The domain registry" detail={failure} />
      </>
    );
  }

  const domains = data.domains;
  const pending = domains.filter((d) => d.status === 'pending').length;

  return (
    <>
      <PageHead
        title="Domains"
        sub="The registry behind every tier. Zone A eligibility is granted by ownership verification alone (§8.2) — registering a domain never grants it."
      />

      {pending > 0 && (
        <div className="notice" data-tone="warn">
          <strong>{pending} domain{pending === 1 ? '' : 's'} pending.</strong> A pending T1 domain
          is registered but not yet verified, so nothing from it can reach Zone A.
        </div>
      )}

      {/* Filters are links, not a JS control: each is a real URL an operator can
          bookmark or send to someone else. */}
      <Panel title="Filter">
        <div className="panelBody actions">
          {['', 'T0', 'T1', 'T2', 'T3'].map((t) => (
            <a
              key={t || 'all'}
              href={`/admin/domains${t ? `?tier=${t}` : ''}`}
              className="btn"
              data-tone={tier === t ? 'primary' : undefined}
            >
              {t || 'All tiers'}
            </a>
          ))}
          <span style={{ width: 12 }} />
          {['pending', 'active', 'blocked'].map((s) => (
            <a
              key={s}
              href={`/admin/domains?status=${s}`}
              className="btn"
              data-tone={status === s ? 'primary' : undefined}
            >
              {s}
            </a>
          ))}
        </div>
      </Panel>

      {admin && (
        <Panel title="Register a domain" note="§8.1 — all registrations land as pending">
          <div className="panelBody">
            <ActionForm action={addDomainAction}>
              <div className="formGrid">
                <div>
                  <label htmlFor="d-host">Host</label>
                  <input id="d-host" name="host" type="text" placeholder="example.org" required />
                </div>
                <div>
                  <label htmlFor="d-tier">Tier</label>
                  <select id="d-tier" name="tier" defaultValue="T1">
                    <option value="T1">T1 — Jubilee network</option>
                    <option value="T2">T2 — whitelisted</option>
                    <option value="T3">T3 — open web</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="d-name">Display name</label>
                  <input id="d-name" name="display_name" type="text" />
                </div>
                <div>
                  <label htmlFor="d-mode">Ingest mode</label>
                  <select id="d-mode" name="ingest_mode" defaultValue="">
                    <option value="">tier default</option>
                    <option value="source">source markdown</option>
                    <option value="crawl">crawl</option>
                    <option value="webhook">webhook</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="d-root">Source root</label>
                  <input id="d-root" name="source_root" type="text" placeholder="/srv/content/example" />
                </div>
                <div>
                  <label htmlFor="d-lang">Language hint</label>
                  <input id="d-lang" name="language_hint" type="text" placeholder="en" />
                </div>
                <div><SubmitButton tone="primary">Register</SubmitButton></div>
              </div>
            </ActionForm>
          </div>
        </Panel>
      )}

      <Panel title="Registered domains" note={`${domains.length} shown`}>
        {domains.length === 0 ? (
          <Empty>No domains match this filter.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Host</th><th>Tier</th><th>Status</th><th>Zone A</th>
                  <th className="numCell">Pages</th><th>Ingest</th>
                  <th className="numCell">Fails</th><th>Last crawl</th>
                  {admin && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">
                      <strong>{d.host}</strong>
                      {d.display_name && (
                        <div style={{ color: 'var(--a-ink-faint)', fontSize: 11.5 }}>{d.display_name}</div>
                      )}
                    </td>
                    <td><Pill tone={TIER_TONE[d.tier] ?? 'neutral'}>{d.tier}</Pill></td>
                    <td>
                      <Pill tone={d.status === 'active' ? 'good' : d.status === 'pending' ? 'warn' : 'bad'}>
                        {d.status}
                      </Pill>
                    </td>
                    <td>
                      {d.zone_a_eligible ? (
                        <>
                          <Pill tone="good">eligible</Pill>
                          <div style={{ fontSize: 11, color: 'var(--a-ink-faint)', marginTop: 3 }}>
                            {d.verification_method} · {when(d.verified_at)}
                          </div>
                        </>
                      ) : (
                        <span style={{ color: 'var(--a-ink-faint)', fontSize: 12 }}>
                          {d.tier === 'T1' ? 'not verified' : 'n/a below T1'}
                        </span>
                      )}
                    </td>
                    <td className="numCell">{num(d.indexed_pages).toLocaleString()}</td>
                    <td>
                      {d.ingest_mode}
                      {d.has_webhook_secret && (
                        <div style={{ fontSize: 11, color: 'var(--a-ink-faint)' }}>secret set</div>
                      )}
                    </td>
                    <td className="numCell" style={{ color: num(d.consecutive_failures) >= 3 ? 'var(--a-bad)' : undefined }}>
                      {num(d.consecutive_failures)}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{when(d.last_crawl_finished)}</td>
                    {admin && (
                      <td>
                        <div className="actions">
                          {d.tier === 'T1' && !d.zone_a_eligible && (
                            <ActionForm action={verifyDomainAction}>
                              <input type="hidden" name="id" value={d.id} />
                              <input type="hidden" name="method" value="authoritative_list" />
                              <SubmitButton
                                tone="good"
                                confirm={`Verify ownership of ${d.host} by authoritative list?\n\nThis is the only route into Zone A. Only do it for a domain the network genuinely controls.`}
                              >
                                Verify
                              </SubmitButton>
                            </ActionForm>
                          )}
                          <ActionForm action={purgeDomainAction}>
                            <input type="hidden" name="id" value={d.id} />
                            <input type="hidden" name="block" value="false" />
                            <SubmitButton
                              tone="danger"
                              confirm={`Purge every page of ${d.host}?\n\n${num(d.indexed_pages)} indexed page(s) are deleted. The registration stays, so it can be re-ingested.`}
                            >
                              Purge
                            </SubmitButton>
                          </ActionForm>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="sub">
        Not yet on this screen: bulk import, editing an existing registration in place, pausing,
        and forced reingest. The API does not expose those four yet, and a button that cannot
        work is worse than none.
      </p>
    </>
  );
}
