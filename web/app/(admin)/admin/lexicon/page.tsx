import type { Metadata } from 'next';
import { getLexicon, previewLexicon, num, AdminRequestFailed } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import { addLexiconTermAction, importLexiconAction } from '@/lib/admin-actions';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Pill, Empty, LoadFailed, Notice } from '@/components/admin/ui';

// Screen 3: lexicon editor (§15).
//
// "Concepts and their terms grouped for editing, with language and weight per
// term, bulk import, and a live preview showing how a sample query expands.
// Enforces the Hebrew article validation rule."
//
// The preview asks the engine to run the query pipeline's own expansion step
// (routes/admin-ops.js -> query/lexicon.js expand) without running a search,
// so what it shows is what a reader's search would use, not a browser-side
// imitation of it. It is a GET form, so a preview is a URL that can be shared.

export const metadata: Metadata = { title: 'Lexicon' };

export default async function LexiconPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const sample = one(params.q).trim();
  const sampleLang = one(params.lang).trim();

  const session = await getSession();
  const admin = isAdmin(session);

  let data;
  let failure = '';
  try {
    data = await getLexicon();
  } catch (err) {
    failure = err instanceof AdminRequestFailed ? err.message : String(err);
  }

  if (!data) {
    return (
      <>
        <PageHead title="Lexicon" />
        <LoadFailed what="The lexicon" detail={failure} />
      </>
    );
  }

  let preview = null;
  let previewError = '';
  if (sample) {
    try { preview = await previewLexicon(sample, sampleLang || undefined); } catch (err) {
      previewError = err instanceof AdminRequestFailed ? err.message : String(err);
    }
  }

  const concepts = data.concepts;
  const termCount = concepts.reduce((n, c) => n + (c.terms?.length ?? 0), 0);

  return (
    <>
      <PageHead
        title="Lexicon"
        sub={`${concepts.length} concepts, ${termCount} terms. This is what lets a search for "repentance" find a page that says "teshuvah", and the reverse.`}
      />

      <Panel title="Preview an expansion" note="exactly what the query pipeline does, without the search">
        <div className="panelBody">
          <form method="GET" className="formGrid">
            <div style={{ gridColumn: '1 / span 2' }}>
              <label htmlFor="lx-q">Sample query</label>
              <input id="lx-q" name="q" type="text" defaultValue={sample} placeholder="the ruach kodesh" required />
            </div>
            <div>
              <label htmlFor="lx-qlang">Language (blank = detect)</label>
              <input id="lx-qlang" name="lang" type="text" defaultValue={sampleLang} placeholder="en" />
            </div>
            <div><button type="submit" className="btn" data-tone="primary">Preview</button></div>
          </form>

          {previewError && <div className="notice" data-tone="bad" style={{ marginTop: 14, marginBottom: 0 }}>{previewError}</div>}

          {preview && (
            <div style={{ marginTop: 16 }}>
              <div className="sub" style={{ marginBottom: 8 }}>
                Normalised to <span className="mono">{preview.normalized}</span> · language <Pill>{preview.lang}</Pill>
              </div>
              {preview.concepts.length === 0 ? (
                <Notice tone="warn">No concept matched, so this query is searched as typed.</Notice>
              ) : (
                <>
                  <div style={{ marginBottom: 8 }}>
                    Concepts hit: {preview.concepts.map((c) => <Pill key={c} tone="accent">{c}</Pill>)}
                  </div>
                  <div className="scroll">
                    <table>
                      <thead><tr><th className="numCell">Weight</th><th className="wrapCell">Terms added to the search</th></tr></thead>
                      <tbody>
                        {preview.groups.map((g) => (
                          <tr key={g.weight}>
                            <td className="numCell">{g.weight.toFixed(1)}</td>
                            <td className="wrapCell mono">{g.terms.join(' · ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </Panel>

      {admin && (
        <Panel title="Add or update a term" note="the doubled-article rule is enforced by the database">
          <div className="panelBody">
            <ActionForm action={addLexiconTermAction}>
              <div className="formGrid">
                <div>
                  <label htmlFor="lx-concept">Concept</label>
                  <select id="lx-concept" name="concept_key" required defaultValue="">
                    <option value="" disabled>choose…</option>
                    {concepts.map((c) => (
                      <option key={c.id} value={c.concept_key}>{c.concept_key}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="lx-term">Term</label>
                  <input id="lx-term" name="term" type="text" required placeholder="teshuvah" />
                </div>
                <div>
                  <label htmlFor="lx-lang">Language</label>
                  <input id="lx-lang" name="lang" type="text" required defaultValue="en" />
                </div>
                <div>
                  <label htmlFor="lx-register">Register</label>
                  <input id="lx-register" name="register" type="text" placeholder="hebraic / plain" />
                </div>
                <div>
                  <label htmlFor="lx-weight">Weight</label>
                  <input id="lx-weight" name="weight" type="number" step="any" placeholder="1.0" />
                </div>
                <div>
                  <label htmlFor="lx-primary">
                    <input id="lx-primary" name="is_primary" type="checkbox" style={{ width: 'auto', marginRight: 6 }} />
                    Primary term
                  </label>
                </div>
                <div><SubmitButton tone="primary">Save term</SubmitButton></div>
              </div>
            </ActionForm>
          </div>
        </Panel>
      )}

      {admin && (
        <Panel title="Bulk import" note="CSV with a header row, or a JSON array; new concepts are created, existing terms updated">
          <div className="panelBody">
            <ActionForm action={importLexiconAction}>
              <label htmlFor="lx-csv">Rows</label>
              <textarea id="lx-csv" name="csv" rows={6} required
                        placeholder={'concept_key,gloss,term,lang,register,weight,is_primary\nteshuvah,Repentance and return,teshuvah,en,hebraic,1,true\nteshuvah,,repentance,en,plain,0.9,false'}
                        style={{ width: '100%', fontFamily: 'var(--a-mono)', fontSize: 12 }} />
              <div className="actions" style={{ marginTop: 10 }}>
                <SubmitButton tone="primary">Import</SubmitButton>
                <span className="sub">Columns: concept_key, term, lang (required); gloss, register, weight, is_primary. Up to 5000 rows. Terms breaking the doubled-article rule are reported and skipped.</span>
              </div>
            </ActionForm>
          </div>
        </Panel>
      )}

      {concepts.length === 0 ? (
        <Panel><Empty>The lexicon is empty.</Empty></Panel>
      ) : (
        concepts.map((c) => (
          <Panel
            key={c.id}
            title={c.concept_key}
            note={
              <>
                {c.gloss}
                {!c.active && <> · <Pill tone="bad">inactive</Pill></>}
              </>
            }
          >
            {(c.terms?.length ?? 0) === 0 ? (
              <Empty>No terms yet — this concept expands to nothing.</Empty>
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Term</th><th>Lang</th><th>Register</th>
                      <th className="numCell">Weight</th><th>Primary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(c.terms ?? []).map((t) => (
                      <tr key={t.id}>
                        <td className="mono"><strong>{t.term}</strong></td>
                        <td>{t.lang}</td>
                        <td>{t.register ? <Pill>{t.register}</Pill> : '—'}</td>
                        <td className="numCell">{t.weight === null ? '—' : num(t.weight).toFixed(2)}</td>
                        <td>{t.is_primary ? <Pill tone="accent">primary</Pill> : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {c.notes && (
              <div className="panelBody" style={{ borderTop: '1px solid var(--a-line-soft)', fontSize: 12.5, color: 'var(--a-ink-dim)' }}>
                {c.notes}
              </div>
            )}
          </Panel>
        ))
      )}
    </>
  );
}
