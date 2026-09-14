import type { Metadata } from 'next';
import { getDomains, num, AdminRequestFailed } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import {
  verifyDomainAction, purgeDomainAction, addDomainAction, updateDomainAction,
  pauseDomainAction, reingestDomainAction, importDomainsAction, issueVerificationTokenAction,
} from '@/lib/admin-actions';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Pill, Empty, LoadFailed, when } from '@/components/admin/ui';

// Screen 2: domains (§15).
//
// "List, filter, add, edit, bulk import, verify ownership, set ingest mode and
// source root, force reingest, pause, purge." All of it is here now. Editing
// opens inline under the row rather than on another page, so the table stays
// the one place the registry is read.
//
// Verification (§8.2) is a security control: DNS and well-known are PROOFS the
// engine checks itself against a token issued here, and only the authoritative
// list is taken on the operator's word.

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
            <a key={t || 'all'} href={`/admin/domains${t ? `?tier=${t}` : ''}`} className="btn"
               data-tone={tier === t ? 'primary' : undefined}>
              {t || 'All tiers'}
            </a>
          ))}
          <span style={{ width: 12 }} />
          {['pending', 'active', 'paused', 'blocked'].map((s) => (
            <a key={s} href={`/admin/domains?status=${s}`} className="btn"
               data-tone={status === s ? 'primary' : undefined}>
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
                    <option value="source_md">source markdown</option>
                    <option value="crawl">crawl</option>
                    <option value="hybrid">hybrid (source, then crawl)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="d-root">Source root</label>
                  <input id="d-root" name="source_root" type="text" placeholder="/srv/content/example or https://cdn…" />
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

      {admin && (
        <Panel title="Bulk import" note="§8.1 — CSV with a header row, or a JSON array; existing hosts are updated">
          <div className="panelBody">
            <ActionForm action={importDomainsAction}>
              <label htmlFor="d-csv">Rows</label>
              <textarea id="d-csv" name="csv" rows={6} required
                        placeholder={'host,tier,display_name,ingest_mode,source_root,url_template,language_hint\njubileeverse.com,T1,JubileeVerse,source_md,https://cdn.example/jv,https://{host}/{slug},en'}
                        style={{ width: '100%', fontFamily: 'var(--a-mono)', fontSize: 12 }} />
              <div className="actions" style={{ marginTop: 10 }}>
                <SubmitButton tone="primary">Import</SubmitButton>
                <span className="sub">Columns: host, tier (required); display_name, ingest_mode, source_root, url_template, owner_org, crawl_interval_hours, max_pages, max_depth, crawl_delay_ms, respect_robots, language_hint. Up to 2000 rows.</span>
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
                  <DomainRow key={d.id} d={d} admin={admin} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

type DomainT = Awaited<ReturnType<typeof getDomains>>['domains'][number];

function DomainRow({ d, admin }: { d: DomainT; admin: boolean }) {
  const paused = d.status === 'paused';
  const inert = d.status === 'blocked' || d.status === 'purged';
  return (
    <>
      <tr>
        <td className="mono">
          <strong>{d.host}</strong>
          {d.display_name && (
            <div style={{ color: 'var(--a-ink-faint)', fontSize: 11.5 }}>{d.display_name}</div>
          )}
        </td>
        <td><Pill tone={TIER_TONE[d.tier] ?? 'neutral'}>{d.tier}</Pill></td>
        <td>
          <Pill tone={d.status === 'active' ? 'good' : d.status === 'pending' || paused ? 'warn' : 'bad'}>
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
              {!inert && (
                <ActionForm action={pauseDomainAction}>
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="paused" value={paused ? 'false' : 'true'} />
                  <SubmitButton tone={paused ? 'good' : undefined}>{paused ? 'Resume' : 'Pause'}</SubmitButton>
                </ActionForm>
              )}
              {!inert && (
                <ActionForm action={reingestDomainAction}>
                  <input type="hidden" name="id" value={d.id} />
                  <SubmitButton confirm={`Force a full re-ingest of ${d.host}?\n\nEvery page's change detection is reset and the domain is made due now. ${num(d.indexed_pages)} page(s) will be re-read on the next run.`}>
                    Reingest
                  </SubmitButton>
                </ActionForm>
              )}
              <ActionForm action={purgeDomainAction}>
                <input type="hidden" name="id" value={d.id} />
                <input type="hidden" name="block" value="false" />
                <SubmitButton tone="danger"
                  confirm={`Purge every page of ${d.host}?\n\n${num(d.indexed_pages)} indexed page(s) are deleted. The registration stays, so it can be re-ingested.`}>
                  Purge
                </SubmitButton>
              </ActionForm>
            </div>
          </td>
        )}
      </tr>

      {admin && (
        <tr>
          <td colSpan={9} style={{ padding: 0, borderTop: 0 }}>
            <details className="rowDetails">
              <summary>Edit {d.host}{d.tier === 'T1' && !d.zone_a_eligible ? ' · verify ownership' : ''}</summary>
              <div className="panelBody" style={{ display: 'grid', gap: 18 }}>
                <ActionForm action={updateDomainAction}>
                  <input type="hidden" name="id" value={d.id} />
                  <div className="formGrid">
                    <div>
                      <label htmlFor={`e-name-${d.id}`}>Display name</label>
                      <input id={`e-name-${d.id}`} name="display_name" type="text" defaultValue={d.display_name ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`e-tier-${d.id}`}>Tier</label>
                      <select id={`e-tier-${d.id}`} name="tier" defaultValue={d.tier}>
                        {['T0', 'T1', 'T2', 'T3'].map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`e-mode-${d.id}`}>Ingest mode</label>
                      <select id={`e-mode-${d.id}`} name="ingest_mode" defaultValue={d.ingest_mode}>
                        <option value="source_md">source markdown</option>
                        <option value="crawl">crawl</option>
                        <option value="hybrid">hybrid</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`e-root-${d.id}`}>Source root</label>
                      <input id={`e-root-${d.id}`} name="source_root" type="text" defaultValue={d.source_root ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`e-tpl-${d.id}`}>URL template</label>
                      <input id={`e-tpl-${d.id}`} name="url_template" type="text" defaultValue={d.url_template ?? ''} placeholder="https://{host}/{slug}" />
                    </div>
                    <div>
                      <label htmlFor={`e-org-${d.id}`}>Owner org</label>
                      <input id={`e-org-${d.id}`} name="owner_org" type="text" defaultValue={d.owner_org ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`e-int-${d.id}`}>Crawl interval (hours)</label>
                      <input id={`e-int-${d.id}`} name="crawl_interval_hours" type="number" min={1} defaultValue={num(d.crawl_interval_hours) || ''} />
                    </div>
                    <div>
                      <label htmlFor={`e-max-${d.id}`}>Max pages</label>
                      <input id={`e-max-${d.id}`} name="max_pages" type="number" min={0} defaultValue={d.max_pages == null ? '' : num(d.max_pages)} />
                    </div>
                    <div>
                      <label htmlFor={`e-depth-${d.id}`}>Max depth</label>
                      <input id={`e-depth-${d.id}`} name="max_depth" type="number" min={0} defaultValue={num(d.max_depth)} />
                    </div>
                    <div>
                      <label htmlFor={`e-delay-${d.id}`}>Crawl delay (ms)</label>
                      <input id={`e-delay-${d.id}`} name="crawl_delay_ms" type="number" min={0} defaultValue={num(d.crawl_delay_ms)} />
                    </div>
                    <div>
                      <label htmlFor={`e-lang-${d.id}`}>Language hint</label>
                      <input id={`e-lang-${d.id}`} name="language_hint" type="text" defaultValue={d.language_hint ?? ''} />
                    </div>
                    <div>
                      <label htmlFor={`e-robots-${d.id}`}>
                        <input type="hidden" name="respect_robots_present" value="1" />
                        <input id={`e-robots-${d.id}`} name="respect_robots" type="checkbox" defaultChecked={d.respect_robots}
                               disabled={d.tier !== 'T1'} style={{ width: 'auto', marginRight: 6 }} />
                        Respect robots.txt {d.tier !== 'T1' && <span className="sub">(always on below T1)</span>}
                      </label>
                    </div>
                    <div><SubmitButton tone="primary">Save changes</SubmitButton></div>
                  </div>
                </ActionForm>

                {d.tier === 'T1' && !d.zone_a_eligible && (
                  <div style={{ borderTop: '1px solid var(--a-line-soft)', paddingTop: 14 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>Ownership verification (§8.2)</div>
                    <p className="sub" style={{ marginTop: 0 }}>
                      Issue a token, have the owner publish it as a DNS TXT record or a well-known file,
                      then check the proof. The authoritative list is an attestation and needs no token.
                    </p>
                    <div className="actions">
                      <ActionForm action={issueVerificationTokenAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <SubmitButton>Issue token</SubmitButton>
                      </ActionForm>
                      <ActionForm action={verifyDomainAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <input type="hidden" name="method" value="dns_txt" />
                        <SubmitButton tone="good">Check DNS TXT</SubmitButton>
                      </ActionForm>
                      <ActionForm action={verifyDomainAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <input type="hidden" name="method" value="well_known" />
                        <SubmitButton tone="good">Check well-known file</SubmitButton>
                      </ActionForm>
                      <ActionForm action={verifyDomainAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <input type="hidden" name="method" value="authoritative_list" />
                        <SubmitButton tone="good"
                          confirm={`Verify ownership of ${d.host} by authoritative list?\n\nThis is the only route into Zone A. Only do it for a domain the network genuinely controls.`}>
                          Attest by authoritative list
                        </SubmitButton>
                      </ActionForm>
                    </div>
                  </div>
                )}
              </div>
            </details>
          </td>
        </tr>
      )}
    </>
  );
}
