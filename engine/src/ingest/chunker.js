// Chunking (§12.1).
//
//   * Target 400 to 600 tokens per chunk, 15% overlap
//   * Split on heading boundaries first, then paragraph boundaries, never
//     mid-sentence
//   * Each chunk stores its heading_path breadcrumb, and the chunk text is
//     prefixed with the page title plus that breadcrumb before embedding
//   * For T1 source-markdown ingest, heading structure comes directly from the
//     markdown tree rather than being inferred from HTML
//   * Pages under 100 words produce a single chunk
//   * Pages under 25 words of main content are rejected as thin content

import { stripMarkdown, parseFrontmatter } from './markdown.js';

export const TARGET_TOKENS = 500;
export const MAX_TOKENS = 600;
export const MIN_TOKENS = 400;
export const OVERLAP_RATIO = 0.15;
export const SINGLE_CHUNK_WORDS = 100;
export const THIN_CONTENT_WORDS = 25;

// Token estimate, not a token count. bge-m3 uses a SentencePiece vocabulary that
// is not available in this process, and shipping a copy of it to get chunk
// boundaries a few percent tighter is not worth the dependency.
//
// 1.35 tokens per whitespace word is the ratio that holds for the mixed
// English/Hebrew-transliteration/Romanian text on this network -- transliterated
// Hebrew fragments into more pieces than ordinary English does, and Devanagari
// more again. The estimate runs high on purpose: overshooting the target
// produces chunks slightly under 600 real tokens, while undershooting produces
// chunks that the embedding model silently truncates.
const TOKENS_PER_WORD = 1.35;
export const estimateTokens = (text) =>
  Math.ceil(String(text ?? '').split(/\s+/).filter(Boolean).length * TOKENS_PER_WORD);

/**
 * @param {string} markdown  the article source; a leading frontmatter block is
 *                           removed here if one is still present
 * @param {{title?: string}} page
 * @returns {{chunks: Array, rejected: string|null}}
 *
 * This used to be documented as "frontmatter already removed" and every one of
 * its three callers passed the raw file anyway -- jobs/ingest.js,
 * api/routes/ingest.js and jobs/import-cdn.js. The result was chunks whose first
 * few hundred characters were `---,title: "...",slug: ...`, embedded as though
 * the YAML were prose.
 *
 * When every caller violates a contract, the contract is the thing that is
 * wrong. Stripping here fixes all three at once and cannot be got wrong by a
 * fourth. It is idempotent: text with no frontmatter is returned untouched.
 */
export function chunkMarkdown(markdown, page = {}) {
  const { body } = parseFrontmatter(markdown);
  const plain = stripMarkdown(body);
  const words = plain.split(/\s+/).filter(Boolean).length;

  if (words < THIN_CONTENT_WORDS) {
    return { chunks: [], rejected: 'thin_content' };
  }
  if (words < SINGLE_CHUNK_WORDS) {
    return { chunks: [finish(plain, '', page, 0)], rejected: null };
  }

  const chunks = [];
  // `body`, not `markdown`: the frontmatter was stripped above, and splitting
  // the raw file instead would put the YAML block back as the first section.
  for (const section of splitSections(body)) {
    // `.join('\n')`, and it is load-bearing. `section.body` is the ARRAY of
    // lines splitSections collected; handing an array to stripMarkdown coerces
    // it with String(), which joins on a COMMA. Every chunk built through this
    // path came out as ",First line.,,Second line.," -- line breaks replaced by
    // commas, paragraph breaks by double commas.
    //
    // It corrupted the text twice over: the embedding was computed on
    // comma-spliced prose, and the same string is what a semantic-only result
    // shows as its snippet, so readers saw it too. The two other places in this
    // file that touch `.body` already join on '\n'; this one did not.
    const text = stripMarkdown(section.body.join('\n'));
    if (!text) continue;
    for (const piece of splitToWindows(text)) {
      chunks.push(finish(piece, section.headingPath, page, chunks.length));
    }
  }

  // A document that is all headings and no prose still has to produce something,
  // or it disappears from the vector path entirely while remaining in the
  // lexical one -- a difference nobody could explain from a debug payload.
  if (chunks.length === 0) return { chunks: [finish(plain, '', page, 0)], rejected: null };

  return { chunks, rejected: null };
}

// Split the markdown at ATX headings, carrying a breadcrumb down the tree.
// Fenced code is skipped so a `# comment` inside a block does not open a section.
export function splitSections(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const sections = [];
  const stack = [];
  let current = { headingPath: '', body: [] };
  let inFence = false;

  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      current.body.push(line);
      continue;
    }
    const m = inFence ? null : line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) { current.body.push(line); continue; }

    if (current.body.join('\n').trim()) sections.push(current);

    const level = m[1].length;
    const text = stripMarkdown(m[2]);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text });

    current = { headingPath: stack.map((h) => h.text).join(' > '), body: [] };
  }
  if (current.body.join('\n').trim()) sections.push(current);
  return sections;
}

/**
 * Cut one section into windows of roughly TARGET_TOKENS with OVERLAP_RATIO of
 * carry-over, breaking on paragraphs and falling back to sentences. Never
 * mid-sentence: a chunk that ends halfway through a clause embeds badly and
 * reads worse when it becomes a snippet.
 */
export function splitToWindows(text) {
  if (estimateTokens(text) <= MAX_TOKENS) return [text];

  const units = splitUnits(text);
  const windows = [];
  let buffer = [];
  let tokens = 0;

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);

    // A single paragraph longer than the maximum is split by sentence; a single
    // sentence longer than the maximum is emitted whole, because the alternative
    // is breaking mid-sentence, which §12.1 rules out.
    if (unitTokens > MAX_TOKENS) {
      if (buffer.length) { windows.push(buffer.join('\n\n')); buffer = []; tokens = 0; }
      windows.push(...splitLongUnit(unit));
      continue;
    }

    if (tokens + unitTokens > MAX_TOKENS && buffer.length) {
      windows.push(buffer.join('\n\n'));
      buffer = overlapTail(buffer, tokens);
      tokens = buffer.reduce((sum, u) => sum + estimateTokens(u), 0);
    }

    buffer.push(unit);
    tokens += unitTokens;
  }

  if (buffer.length) {
    const tail = buffer.join('\n\n');
    // Do not leave a sliver behind. A 40-token trailing chunk carries no context
    // and pollutes nearest-neighbour results with a near-empty vector.
    if (windows.length && estimateTokens(tail) < MIN_TOKENS / 4) {
      windows[windows.length - 1] += `\n\n${tail}`;
    } else {
      windows.push(tail);
    }
  }
  return windows;
}

const splitUnits = (text) =>
  text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);

function splitLongUnit(unit) {
  const sentences = unit.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) ?? [unit];
  const out = [];
  let buffer = [];
  let tokens = 0;
  for (const sentence of sentences) {
    const t = estimateTokens(sentence);
    if (tokens + t > MAX_TOKENS && buffer.length) {
      out.push(buffer.join('').trim());
      buffer = [];
      tokens = 0;
    }
    buffer.push(sentence);
    tokens += t;
  }
  if (buffer.length) out.push(buffer.join('').trim());
  return out;
}

// 15% of the window carried into the next one, taken as whole units from the
// end. Overlap is what stops an answer that straddles a boundary from being
// invisible to both chunks.
function overlapTail(buffer, tokens) {
  const budget = tokens * OVERLAP_RATIO;
  const tail = [];
  let carried = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const t = estimateTokens(buffer[i]);
    if (carried + t > budget && tail.length) break;
    tail.unshift(buffer[i]);
    carried += t;
    if (carried >= budget) break;
  }
  return tail;
}

/**
 * §12.1: "the chunk text is prefixed with the page title plus that breadcrumb
 * before embedding, which materially improves retrieval on long articles."
 *
 * The prefix goes in `embed_text` and not in `text`. They are different things:
 * `text` is what a snippet is cut from and what a reader sees, and prefixing
 * every snippet with its own breadcrumb would be noise on the page.
 */
function finish(text, headingPath, page, ordinal) {
  // On a well-formed article the breadcrumb already opens with the H1, and the
  // H1 is the title. Emitting both gives every chunk of every page a prefix that
  // says the same thing twice -- wasted context window on a model with a fixed
  // budget, and a duplicated phrase that the embedding then has to account for.
  const crumbs = headingPath ? headingPath.split(' > ') : [];
  if (page.title && crumbs[0] === page.title) crumbs.shift();
  const prefix = [page.title, ...crumbs].filter(Boolean).join(' > ');
  const body = text.trim();
  return {
    ordinal,
    heading_path: headingPath || null,
    text: body,
    token_count: estimateTokens(body),
    embed_text: prefix ? `${prefix}\n\n${body}` : body,
  };
}
