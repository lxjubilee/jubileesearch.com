import { Fragment } from 'react';

// Render a snippet, honouring the `<mark>` tags `ts_headline` wraps matches in
// and nothing else.
//
// The static site escaped the whole string and then put `<mark>` back with two
// `.replace()` calls before handing it to `innerHTML`. That works, but it is an
// HTML-injection bug one careless edit away: anyone who later adds `<b>` to the
// allow-list, or reorders the escape and the un-escape, opens the hole.
//
// This never builds an HTML string at all. The snippet is split on the tag and
// the pieces become React text nodes, which React escapes by construction, with
// the marked ones wrapped in a real `<mark>` element. There is no path from
// crawled page text to executable markup, because there is no parser to fool.
//
// It matters more than it looks: Zone B snippets come from pages the engine
// fetched off the open web, and §17 requires that fetched content is never
// rendered without sanitisation.

const SPLIT = /(<\/?mark>)/i;

export default function Snippet({ text }: { text: string | null }) {
  if (!text) return null;

  const parts = text.split(SPLIT);
  let marked = false;

  return (
    <>
      {parts.map((part, index) => {
        if (/^<mark>$/i.test(part)) { marked = true; return null; }
        if (/^<\/mark>$/i.test(part)) { marked = false; return null; }
        if (!part) return null;
        return marked
          ? <mark key={index}>{part}</mark>
          : <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}
