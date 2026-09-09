import type { Metadata } from 'next';
import { getLexicon, num, AdminRequestFailed } from '@/lib/admin';
import { getSession, isAdmin } from '@/lib/session';
import { addLexiconTermAction } from '@/lib/admin-actions';
import { ActionForm, SubmitButton } from '@/components/admin/ActionForm';
import { PageHead, Panel, Pill, Empty, LoadFailed } from '@/components/admin/ui';

// Screen 3: lexicon editor (§15).
//
// "Concepts and their terms grouped for editing, with language and weight per
// term, bulk import, and a live preview showing how a sample query expands.
// Enforces the Hebrew article validation rule."
//
// The validation rule is enforced in the database, not here: a CHECK constraint
// named `lexicon_terms_no_doubled_article` refuses a term carrying both the
// English article and the Hebrew Ha- prefix. The API translates that constraint
// into a sentence an editor can act on, and this page shows it. Re-implementing
// the check in the browser would give two rules to keep in step, and the one
// that matters would still be the database's.
//
// `register` appears here and on no reader-facing surface. §7.5 makes it an
// internal editing label; this is the console, so it is shown.

export const metadata: Metadata = { title: 'Lexicon' };

export default async function LexiconPage() {
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

  const concepts = data.concepts;
  const termCount = concepts.reduce((n, c) => n + (c.terms?.length ?? 0), 0);

  return (
    <>
      <PageHead
        title="Lexicon"
        sub={`${concepts.length} concepts, ${termCount} terms. This is what lets a search for "repentance" find a page that says "teshuvah", and the reverse.`}
      />

      {admin && (
        <Panel
          title="Add or update a term"
          note="the doubled-article rule is enforced by the database"
        >
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

      <p className="sub">
        Not yet on this screen: bulk import, and the live preview of how a sample query expands.
        The preview needs an endpoint that runs expansion without running a search; the API has
        none, and faking it in the browser would preview something other than what the engine does.
      </p>
    </>
  );
}
