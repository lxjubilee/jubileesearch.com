// Site boilerplate removed at extraction (migration 038).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.USE_PGLITE = '1';
delete process.env.PGLITE_DIR;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

const NAV = '## Related messages\n\n- Teaching My Children 10 min Imani Isaiah 58:12\n- Whole Not Coping 12 min Amir John 5:6';
const page = (n) => `<html><head><title>Article ${n}</title></head><body>
<nav><ul><li>Home</li><li>Messages</li></ul></nav>
<main>
<h1>Article ${n}</h1>
${'<p>Paragraph of the article number ' + n + ' about teshuvah, grace and returning home after a long time away from the table. It keeps going so the scorer sees a real article here.</p>'.repeat(4)}
<h2>Related messages</h2>
<ul><li>Teaching My Children 10 min Imani Isaiah 58:12</li><li>Whole Not Coping 12 min Amir John 5:6</li></ul>
</main></body></html>`;

let pool; let ex; let store;

before(async () => {
  ({ pool } = await import('../src/db.js'));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) await pool.query(await readFile(join(migrationsDir, file), 'utf8'));
  ex = await import('../src/crawl/extractor.js');
  store = await import('../src/crawl/store.js');
});
after(async () => { await pool?.end(); });

describe('block hashing', () => {
  test('markers, case and whitespace do not change a block\'s identity', () => {
    const a = ex.blockHash('## Related   Messages');
    assert.equal(a, ex.blockHash('related messages'));
    assert.notEqual(a, ex.blockHash('related messages 10 min'));
  });

  test('stripBoilerplate drops only the listed blocks and keeps order', () => {
    const md = 'Intro paragraph.\n\n' + NAV + '\n\nClosing paragraph.';
    const set = new Set(ex.splitBlocks(NAV).map(ex.blockHash));
    const r = ex.stripBoilerplate(md, set);
    assert.equal(r.removed, ex.splitBlocks(NAV).length);
    assert.equal(r.markdown, 'Intro paragraph.\n\nClosing paragraph.');
  });

  test('a page keeps its own title even when other pages list it as boilerplate', () => {
    const md = '# Am vrut putere si am primit un regulament\n\nIntro paragraph.\n\n- Am vrut putere si am primit un regulament\n\nClosing.';
    const listed = new Set([ex.blockHash('- Am vrut putere si am primit un regulament')]);
    const r = ex.stripBoilerplate(md, listed, { title: 'Am vrut putere si am primit un regulament' });
    assert.ok(r.markdown.startsWith('# Am vrut putere'), 'the H1 stays');
    assert.ok(!r.markdown.includes('- Am vrut putere'), 'the list item goes');
    assert.equal(r.removed, 1);
  });

  test('extract() reports every block and strips the known ones before hashing', () => {
    const clean = ex.extract(page(1), 'https://s.example/1');
    assert.ok(clean.block_hashes.length >= 3);
    assert.equal(clean.extraction.boilerplate_removed, 0);
    const set = new Set(clean.block_hashes.filter((h) => h === ex.blockHash('Related messages') || h === ex.blockHash('- Teaching My Children 10 min Imani Isaiah 58:12')));
    const stripped = ex.extract(page(1), 'https://s.example/1', { boilerplate: set });
    assert.ok(stripped.extraction.boilerplate_removed >= 1);
    assert.ok(!stripped.body_text.includes('Related messages'));
    assert.notDeepEqual(stripped.content_hash, clean.content_hash, 'the hash follows the cleaned text');
  });
});

describe('learning a site\'s template', () => {
  test('a block seen on three pages of a domain becomes boilerplate for the fourth', async () => {
    const { rows: [d] } = await pool.query(
      `INSERT INTO domains (host, tier, status) VALUES ('s.example', 'T1', 'active') RETURNING *`);
    const cfg = await (await import('../src/config.js')).ranking();
    const verdict = { verdict: 'safe', score: 0, reasons: [] };
    for (let n = 1; n <= 3; n += 1) {
      assert.equal((await store.siteBoilerplate(pool, d.id)).size, 0, `nothing repeats before page ${n}`);
      const extracted = ex.extract(page(n), `https://s.example/${n}`);
      await store.upsertCrawledPage(d, { url: `https://s.example/${n}`, final_url: `https://s.example/${n}`, http_status: 200, content_type: 'text/html' }, extracted, verdict, cfg);
    }
    const set = await store.siteBoilerplate(pool, d.id);
    assert.ok(set.has(ex.blockHash('## Related messages')), 'the heading repeats on all three');
    assert.ok(!set.has(ex.blockHash('# Article 1')), 'the title is unique to its page');

    const fourth = ex.extract(page(4), 'https://s.example/4', { boilerplate: set });
    assert.ok(fourth.extraction.boilerplate_removed >= 1);
    assert.ok(!fourth.body_text.includes('Related messages'));
    assert.ok(fourth.body_text.includes('Paragraph of the article number 4'));
  });
});
