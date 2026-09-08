// PDF text-layer extraction (§9.5).
//
// "PDF handling: text-layer extraction only. No OCR. Scanned PDFs with no text
// layer are marked `rejected` with reason `no_text_layer`."
//
// ---------------------------------------------------------------------------
// What this does and does not do, stated up front because a PDF extractor that
// quietly returns mojibake is worse than one that returns nothing.
//
// It decodes FlateDecode content streams with the built-in zlib, then reads the
// text-showing operators -- Tj, TJ, ' and " -- out of them. That covers the
// ordinary case: a PDF produced by a word processor or a web-to-PDF tool, with
// text in a standard encoding.
//
// It does not implement font descriptors. A PDF that maps glyphs through a
// custom encoding or a CID font will produce bytes that are not the characters
// a reader sees. Rather than index that, `looksLikeText` checks the result and
// rejects anything that does not read as language -- so the failure mode is
// `no_text_layer`, which is the same outcome the specification prescribes for a
// scan, and which sends the page to the same place.
//
// It also does not handle encrypted PDFs, object streams (a PDF 1.5 feature that
// moves objects inside compressed streams), or cross-reference streams. Those
// come back as no text.
//
// If PDFs turn out to matter on the whitelist tier, the honest upgrade is
// pdf.js or a `pdftotext` sidecar, not more of this.
// ---------------------------------------------------------------------------

import { inflateSync, inflateRawSync, unzipSync } from 'node:zlib';

const MIN_WORDS = 25;   // §12.1 thin-content floor, applied here too

/**
 * @param {Buffer} buffer  the raw PDF
 * @returns {{text: string, ok: boolean, reason?: string, pages?: number}}
 */
export function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { text: '', ok: false, reason: 'not_a_pdf' };
  }

  // An encrypted document will decode to noise. Detecting it here turns a
  // confusing result into a clear one.
  if (buffer.includes(Buffer.from('/Encrypt'))) {
    return { text: '', ok: false, reason: 'encrypted' };
  }

  const streams = collectStreams(buffer);
  if (streams.length === 0) return { text: '', ok: false, reason: 'no_text_layer' };

  const parts = [];
  for (const stream of streams) {
    const decoded = inflate(stream);
    if (!decoded) continue;
    const text = readTextOperators(decoded.toString('latin1'));
    if (text.trim()) parts.push(text);
  }

  const text = parts.join('\n\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (!text) return { text: '', ok: false, reason: 'no_text_layer' };
  if (!looksLikeText(text)) return { text: '', ok: false, reason: 'no_text_layer' };
  if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) {
    return { text, ok: false, reason: 'thin_content' };
  }

  return { text, ok: true, pages: countPages(buffer) };
}

// Walk the file for `stream` ... `endstream` regions. Deliberately not a real
// PDF object parser: without the xref table this is the robust way to find
// content, and a stream that turns out not to be text simply decodes to
// something `readTextOperators` finds nothing in.
function collectStreams(buffer) {
  const out = [];
  const START = Buffer.from('stream');
  const END = Buffer.from('endstream');

  let index = 0;
  while (out.length < 5000) {
    const start = buffer.indexOf(START, index);
    if (start < 0) break;

    // `stream` must be followed by CRLF or LF, per the PDF spec. This also
    // rejects the `endstream` token matching `stream` inside itself.
    let dataStart = start + START.length;
    if (buffer[dataStart] === 0x0d) dataStart++;
    if (buffer[dataStart] === 0x0a) dataStart++;
    else if (buffer[dataStart - 1] !== 0x0a) { index = start + START.length; continue; }

    const end = buffer.indexOf(END, dataStart);
    if (end < 0) break;

    out.push(buffer.subarray(dataStart, end));
    index = end + END.length;
  }
  return out;
}

function inflate(chunk) {
  // Streams may be raw deflate, zlib-wrapped, or gzip; try each rather than
  // reading the /Filter entry, which would mean parsing the object dictionary.
  for (const fn of [inflateSync, inflateRawSync, unzipSync]) {
    try {
      const out = fn(chunk);
      if (out.length) return out;
    } catch { /* next */ }
  }
  // An uncompressed content stream is legal and is already text.
  return chunk.includes(Buffer.from('Tj')) || chunk.includes(Buffer.from('TJ')) ? chunk : null;
}

/**
 * Read the text-showing operators out of a content stream.
 *
 *   (Hello) Tj              a single string
 *   [(He) -120 (llo)] TJ    an array with kerning adjustments between pieces
 *   (Hello) '               next line, then show
 *   a b (Hello) "           word and char spacing, next line, then show
 *
 * A large negative kerning number is a word space that the producer chose not to
 * encode as one; without restoring it, "the appointed times" comes out as
 * "theappointedtimes" and tokenises into a single nonsense word.
 */
function readTextOperators(content) {
  const out = [];
  let i = 0;

  while (i < content.length) {
    const ch = content[i];

    if (ch === '(') {
      const [value, next] = readLiteralString(content, i);
      i = next;
      const operator = peekOperator(content, i);
      if (operator) out.push({ text: value, newline: operator === "'" || operator === '"' });
      continue;
    }

    if (ch === '<' && content[i + 1] !== '<') {
      const close = content.indexOf('>', i);
      if (close < 0) break;
      const value = readHexString(content.slice(i + 1, close));
      i = close + 1;
      if (peekOperator(content, i)) out.push({ text: value, newline: false });
      continue;
    }

    if (ch === '[') {
      const close = findArrayEnd(content, i);
      if (close < 0) { i++; continue; }
      const inner = content.slice(i + 1, close);
      i = close + 1;
      if (peekOperator(content, i) === 'TJ') out.push({ text: readTjArray(inner), newline: false });
      continue;
    }

    // Text positioning operators that start a new line: Td, TD, T*, and the
    // block terminator ET. Without these every page is one run-on line.
    if (ch === 'T' && (content[i + 1] === 'd' || content[i + 1] === 'D' || content[i + 1] === '*')) {
      out.push({ text: '', newline: true });
      i += 2;
      continue;
    }

    i++;
  }

  let text = '';
  for (const piece of out) {
    if (piece.newline && text && !text.endsWith('\n')) text += '\n';
    text += piece.text;
  }
  return text;
}

function readLiteralString(content, start) {
  let i = start + 1;
  let depth = 1;
  let out = '';

  while (i < content.length) {
    const ch = content[i];

    if (ch === '\\') {
      const next = content[i + 1];
      const simple = { n: '\n', r: '\n', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
      if (next in simple) { out += simple[next]; i += 2; continue; }
      // \ddd octal
      const octal = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4));
      if (octal) { out += String.fromCharCode(parseInt(octal[0], 8)); i += 1 + octal[0].length; continue; }
      if (next === '\n') { i += 2; continue; }   // line continuation
      i += 2;
      continue;
    }

    // Parentheses nest inside a literal string and only an unescaped one at
    // depth zero ends it.
    if (ch === '(') { depth++; out += ch; i++; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0) return [out, i + 1];
      out += ch; i++; continue;
    }

    out += ch;
    i++;
  }
  return [out, i];
}

function readHexString(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const padded = clean.length % 2 ? `${clean}0` : clean;
  let out = '';
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

function readTjArray(inner) {
  let out = '';
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '(') {
      const [value, next] = readLiteralString(inner, i);
      out += value;
      i = next;
      continue;
    }
    if (ch === '<') {
      const close = inner.indexOf('>', i);
      if (close < 0) break;
      out += readHexString(inner.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    const number = /^-?\d+(\.\d+)?/.exec(inner.slice(i));
    if (number) {
      // Kerning is in thousandths of an em, negative meaning "move right".
      // Anything past about a fifth of an em is a space the producer did not
      // encode.
      if (Number(number[0]) <= -200) out += ' ';
      i += number[0].length;
      continue;
    }
    i++;
  }
  return out;
}

function findArrayEnd(content, start) {
  let depth = 0;
  for (let i = start; i < content.length; i++) {
    if (content[i] === '(') { i = readLiteralString(content, i)[1] - 1; continue; }
    if (content[i] === '[') depth++;
    else if (content[i] === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function peekOperator(content, from) {
  const ahead = content.slice(from, from + 24);
  const m = /^\s*(?:[-\d.]+\s+)*?(TJ|Tj|'|")/.exec(ahead);
  return m ? m[1] : null;
}

/**
 * The guard that keeps a font-encoding failure from reaching the index.
 *
 * Text extracted through the wrong encoding is not empty, it is bytes -- and
 * bytes tokenise into terms that match nothing and pollute the tsvector. If the
 * result does not look like written language, it is treated as no text layer.
 */
export function looksLikeText(text) {
  const sample = text.slice(0, 4000);
  if (sample.length < 40) return false;

  const letters = (sample.match(/\p{L}/gu) ?? []).length;
  const printable = (sample.match(/[\p{L}\p{N}\p{P}\s]/gu) ?? []).length;

  // At least a third letters, and almost entirely printable.
  if (letters / sample.length < 0.33) return false;
  if (printable / sample.length < 0.92) return false;

  // Real prose has spaces. A stream of glyph indices decoded as latin1 usually
  // does not, and this is the check that catches CID fonts.
  const words = sample.split(/\s+/).filter(Boolean);
  if (words.length < 10) return false;
  const meanWordLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  return meanWordLength >= 2 && meanWordLength <= 15;
}

function countPages(buffer) {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}
