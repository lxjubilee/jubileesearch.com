// COPIED VERBATIM from JubileeInspire.com src/lib/railIcons.ts. The shared rail
// rows store `builtin:<key>`, and this copy is how they resolve here. When a
// glyph is added or retuned there, copy the file again — a key this copy lacks
// renders as the globe, not as nothing.

/**
 * The built-in glyphs a common rail item can choose from.
 *
 * ONE SOURCE, TWO READERS: the admin form builds its dropdown from this list,
 * and both rails resolve `builtin:<key>` through it when they render. A second
 * copy would drift the moment a glyph was retuned, and the symptom would be an
 * icon that looks right in the admin preview and wrong in the rail.
 *
 * These are the destination-shaped icons the apps already ship. The control
 * glyphs (spinner, caret, chevron, close, stop, arrows) are deliberately absent:
 * they read as "this does something to the page", not "this is a place", and in
 * a rail row they look like a mistake.
 *
 * A rail that points at other properties WILL outgrow this list — kJubilee's own
 * rail carries seven items and pastes artwork for every one, because the set it
 * inherited had nothing for "Born Again DNA" or "Daily Bread". That is why the
 * icon column also accepts a raw path; this list is the shortcut, not the fence.
 */

export interface RailIcon {
  /** Stored as `builtin:<key>`. Never rename one — rows reference it. */
  key: string;
  /** Shown in the admin dropdown. */
  label: string;
  viewBox: string;
  /** Single path. Filled with currentColor by the renderer, never stroked. */
  path: string;
}

export const RAIL_ICONS: RailIcon[] = [
  // ── Scripture & reading ────────────────────────────────────────────────
  { key: "bible", label: "Bible", viewBox: "0 0 24 24",
    path: "M5.5 2A2.5 2.5 0 0 0 3 4.5v15A2.5 2.5 0 0 0 5.5 22H20V2H5.5zM7 4h11v14H7a2.5 2.5 0 0 0-2 .5V4.5c0-.28.22-.5.5-.5H7zm5 2v2h-2v2h2v4h2v-4h2V8h-2V6h-2z" },
  { key: "book", label: "Book", viewBox: "0 0 24 24",
    path: "M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm0 18H6V4h12v16zM8 6h8v2H8V6zm0 4h8v2H8v-2zm0 4h5v2H8v-2z" },
  { key: "bookmark", label: "Bookmark", viewBox: "0 0 24 24",
    path: "M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z" },
  { key: "note", label: "Study note", viewBox: "0 0 24 24",
    path: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2zm-5 16v-5h5l-5 5zM7 7h10v2H7V7zm0 4h10v2H7v-2z" },
  { key: "highlight", label: "Highlight", viewBox: "0 0 24 24",
    path: "M6 14l3 3-2 2H3v-4l3-1zm3.7-1.3l6.6-6.6 3.6 3.6-6.6 6.6-3.6-3.6zM17.7 3.3l3 3a1 1 0 0 1 0 1.4l-1.3 1.3-3.6-3.6 1.3-1.3a1 1 0 0 1 1.4 0z" },
  { key: "cross", label: "Cross", viewBox: "0 0 24 24",
    path: "M14 2h-4v6H4v4h6v10h4V12h6V8h-6V2z" },

  // ── Talking ────────────────────────────────────────────────────────────
  { key: "chat", label: "Chat", viewBox: "0 0 24 24",
    path: "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z" },
  { key: "chat-group", label: "Group chat", viewBox: "0 0 24 24",
    path: "M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.7 0-8 1.3-8 4v3h8v-3c0-1 .4-2 1.3-2.8-.4 0-.8-.2-1.3-.2zm8 0c-.3 0-.7 0-1 .1 1.2.9 2 2 2 3.4V20h7v-3c0-2.7-5.3-4-8-4z" },
  { key: "inbox", label: "Inbox", viewBox: "0 0 24 24",
    path: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z" },
  { key: "history", label: "History", viewBox: "0 0 24 24",
    path: "M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 7 7 7 7 0 0 1-4.9-2L6.7 18.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8H12z" },

  // ── Media ──────────────────────────────────────────────────────────────
  { key: "play", label: "Play / video", viewBox: "0 0 24 24",
    path: "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm6 3v8l6-4-6-4z" },
  { key: "radio", label: "Radio", viewBox: "0 0 24 24",
    path: "M20 6H8.3l6.4-2.6-.8-1.9L4 5.7A2 2 0 0 0 2 8v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 18a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm12-6h-6v-2h6v2z" },
  { key: "music", label: "Music", viewBox: "0 0 24 24",
    path: "M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6z" },
  { key: "speaker", label: "Speaker", viewBox: "0 0 24 24",
    path: "M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" },
  { key: "mic", label: "Microphone", viewBox: "0 0 24 24",
    path: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z" },

  // ── Places & people ────────────────────────────────────────────────────
  { key: "home", label: "Home", viewBox: "0 0 24 24",
    path: "M12 3 2 12h3v8h6v-6h2v6h6v-8h3L12 3z" },
  { key: "globe", label: "Globe", viewBox: "0 0 24 24",
    path: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.9a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.4 2.5 1.8 4h-3.6c.4-1.5 1-2.8 1.8-4zM4.3 14a8 8 0 0 1 0-4h3.3a16.6 16.6 0 0 0 0 4H4.3zm.8 2h2.9c.3 1.3.8 2.5 1.4 3.6A8 8 0 0 1 5.1 16zm2.9-8H5.1a8 8 0 0 1 4.3-3.6A15.7 15.7 0 0 0 8 8zM12 20c-.8-1.2-1.4-2.5-1.8-4h3.6c-.4 1.5-1 2.8-1.8 4zm2.2-6H9.8a14.7 14.7 0 0 1 0-4h4.4a14.7 14.7 0 0 1 0 4zm.4 5.6c.6-1.1 1-2.3 1.4-3.6h2.9a8 8 0 0 1-4.3 3.6zm1.8-5.6a16.6 16.6 0 0 0 0-4h3.3a8 8 0 0 1 0 4h-3.3z" },
  { key: "community", label: "Community", viewBox: "0 0 24 24",
    path: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-4 0-8 2-8 5v3h16v-3c0-3-4-5-8-5z" },
  { key: "apps", label: "Apps", viewBox: "0 0 24 24",
    path: "M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" },
  { key: "star", label: "Star", viewBox: "0 0 24 24",
    path: "M12 2l3 6.6 7 .8-5.2 4.8 1.4 7L12 17.8 5.8 21.2l1.4-7L2 9.4l7-.8L12 2z" },

  // ── Utility ────────────────────────────────────────────────────────────
  { key: "search", label: "Search", viewBox: "0 0 24 24",
    path: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z" },
  { key: "link", label: "Link", viewBox: "0 0 24 24",
    path: "M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z" },
  { key: "share", label: "Share", viewBox: "0 0 24 24",
    path: "M18 16a3 3 0 0 0-2 .8l-7-4a3 3 0 0 0 0-1.6l7-4A3 3 0 1 0 15 5l-7 4a3 3 0 1 0 0 6l7 4A3 3 0 1 0 18 16z" },
  { key: "info", label: "Info", viewBox: "0 0 24 24",
    path: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" },

  // ── From kJubilee's own rail ───────────────────────────────────────────
  // Copied verbatim from kJubilee.com/app/_inspire-rail.js so the two rails
  // can show the same marks. Material Symbols artwork: each carries its own
  // 960 viewBox with the origin at the BOTTOM LEFT, which is why RailIcon
  // stores a viewBox per icon instead of assuming 0 0 24 24 — normalise it
  // and these render off-canvas.
  { key: "chat-new", label: "New chat", viewBox: "0 -960 960 960",
    path: "M120-160v-600q0-33 23.5-56.5T200-840h480q33 0 56.5 23.5T760-760v203q-10-2-20-2.5t-20-.5q-10 0-20 .5t-20 2.5v-203H200v400h283q-2 10-2.5 20t-.5 20q0 10 .5 20t2.5 20H240L120-160Zm160-440h320v-80H280v80Zm0 160h200v-80H280v80Zm400 280v-120H560v-80h120v-120h80v120h120v80H760v120h-80ZM200-360v-400 400Z" },
  { key: "book-open", label: "Open book", viewBox: "0 -960 960 960",
    path: "M260-319.23q49.69 0 96.69 11.27T450-272.61v-393.24q-42.15-27.46-91.23-41.19-49.08-13.73-98.77-13.73-36 0-67.27 5.65-31.27 5.66-64.27 18.5-4.61 1.54-6.54 4.43-1.92 2.88-1.92 6.34v378.31q0 5.39 3.85 7.89 3.84 2.5 8.46.57 28.46-9.69 60.07-14.92 31.62-5.23 67.62-5.23Zm250 46.62q46.31-24.08 93.31-35.35 47-11.27 96.69-11.27 36 0 67.62 5.23 31.61 5.23 60.07 14.92 4.62 1.93 8.46-.57 3.85-2.5 3.85-7.89v-378.31q0-3.46-1.92-6.15-1.93-2.69-6.54-4.62-33-12.84-64.27-18.5-31.27-5.65-67.27-5.65-49.69 0-98.77 13.73T510-665.85v393.24Zm-30 87.99q-48.38-35.69-104.38-55.15-56-19.46-115.62-19.46-36.61 0-71.92 8.11Q152.77-243 120-227.23q-21.38 9.84-40.69-3.12T60-267.08v-434.3q0-12.93 6.66-24.27Q73.31-737 85.85-742q40.61-19.77 84.65-29.27 44.04-9.5 89.5-9.5 58.38 0 114.08 15.96 55.69 15.97 105.92 47.12 50.23-31.15 105.92-47.12 55.7-15.96 114.08-15.96 45.46 0 89.5 9.5T874.15-742q12.54 5 19.19 16.35 6.66 11.34 6.66 24.27v434.3q0 23.77-20.08 36.35-20.08 12.57-42.23 2.73-32.38-15.39-67.11-23.31-34.73-7.92-70.58-7.92-59.62 0-115.62 19.46-56 19.46-104.38 55.15ZM285-496.69Z" },
  { key: "dna", label: "DNA", viewBox: "0 -960 960 960",
    path: "M200-40v-40q0-139 58-225.5T418-480q-102-88-160-174.5T200-880v-40h80v40q0 11 .5 20.5T282-840h396q1-10 1.5-19.5t.5-20.5v-40h80v40q0 139-58 225.5T542-480q102 88 160 174.5T760-80v40h-80v-40q0-11-.5-20.5T678-120H282q-1 10-1.5 19.5T280-80v40h-80Zm138-640h284q13-19 22.5-38t17.5-42H298q8 22 17.5 41.5T338-680Zm142 148q20-17 39-34t36-34H405q17 17 36 34t39 34Zm-75 172h150q-17-17-36-34t-39-34q-20 17-39 34t-36 34ZM298-200h364q-8-22-17.5-41.5T622-280H338q-13 19-22.5 38T298-200Z" },
  { key: "news", label: "Newspaper", viewBox: "0 -960 960 960",
    path: "M162.31-130q-29.83 0-51.07-21.24Q90-172.48 90-202.31v-613.46l57 57 66-67 67 67 67-67 66 67 67-67 67 67 66-67 67 67 67-67 66 67 57-57v613.46q0 29.83-21.24 51.07Q827.52-130 797.69-130H162.31Zm0-60H450v-260H150v247.69q0 5.39 3.46 8.85t8.85 3.46ZM510-190h287.69q5.39 0 8.85-3.46t3.46-8.85V-290H510v100Zm0-160h300v-100H510v100ZM150-510h660v-143.85H150V-510Z" },
  { key: "meal", label: "Meal / daily bread", viewBox: "0 -960 960 960",
    path: "M480-55.69 354.38-180H180v-174.38L55.69-480 180-605.62V-780h174.38L480-904.31 605.62-780H780v174.38L904.31-480 780-354.38V-180H605.62L480-55.69Zm0-84.31 78.85-78.85v-164.54q-23.17-13.39-38.32-45.08-15.14-31.69-15.14-72.75 0-51.78 23.22-88.36 23.22-36.57 57.16-36.57 32.89 0 56.44 36.6 23.56 36.61 23.56 88.4 0 41.79-15.27 73.35-15.27 31.57-38.19 44.41V-240H720v-140l100-100-100-100v-140H580L480-820 380-720H240v140L140-480l100 100v140h107.69v-171.92q-23.3-5.62-38.38-24.79-15.08-19.16-15.08-44.13v-145.31h35.53v134.84h26.64v-134.84h35.52v134.84h26.87v-134.84h35.82v145.31q0 24.97-15.26 44.13-15.27 19.17-38.2 24.79v193.07L480-140Zm0-340Z" },
  { key: "waves", label: "Signal waves", viewBox: "0 -960 960 960",
    path: "M743.08-609.38q-25.4 25.3-58.32 38.42-32.91 13.11-66.38 13.11-33.46 0-65.73-12.73-32.26-12.73-57.73-38.8l-75-75q-16.42-16.54-37.23-24.81-20.81-8.27-42.71-8.27-21.9 0-42.7 8.27-20.79 8.27-37.2 24.81L192-616.69l-42.77-42.77 67.69-68.08q25.56-25.46 57.73-38.19 32.18-12.73 65.3-12.73 33.13 0 64.84 12.73 31.72 12.73 57.29 38.19l75 75q17.48 17.59 38.24 25.84 20.76 8.24 43.06 8.24 22.31 0 43.16-8.27 20.85-8.27 38.38-25.81L768-720.23l42.77 42.77-67.69 68.08Zm0 188.46q-25.49 25.46-58.05 38.19Q652.46-370 619-370t-66.03-12.73q-32.56-12.73-58.05-38.19l-75-75q-16.42-16.54-37.23-24.81-20.81-8.27-42.71-8.27-21.9 0-42.7 8.27-20.79 8.27-37.2 24.81L192-428.23 149.23-470l67.69-69.08q25.56-25.46 57.73-38.19Q306.83-590 339.95-590q33.13 0 64.84 12.73 31.72 12.73 57.29 38.19l75 75q17.36 17.59 37.99 25.84Q595.69-430 618-430t43.35-8.27q21.04-8.27 38.57-25.81L768-531.77 810.77-489l-67.69 68.08Zm-1 188.46q-25.47 25.46-57.55 38.19-32.07 12.73-65.53 12.73t-66.04-12.92q-32.57-12.93-58.04-38.39l-76-74.61Q402.5-324 381.69-332.27q-20.81-8.27-42.71-8.27-21.9 0-42.7 8.27-20.79 8.27-37.2 24.81L191-239.77l-41.77-41.77 67.69-69.08q25.49-25.46 57.59-38.19 32.1-12.73 65.14-12.73t65 12.73q31.96 12.73 57.43 38.19l75 75q17.53 17.54 38.38 25.81t43.16 8.27q22.3 0 43.06-8.24 20.76-8.25 38.24-25.84L768-343.31l41.77 42.77-67.69 68.08Z" },
  { key: "layers", label: "Layers / references", viewBox: "0 -960 960 960",
    path: "M480-240 63-467l84-46 333 182 333-182 84 46-417 227Zm0 160L63-307l84-46 333 182 333-182 84 46L480-80Zm0-320L40-640l440-240 40 22v178h327l73 40-440 240Zm0-91 200-109H440v-167L207-640l273 149Zm-40-109Z" },
];

/** Fast lookup for the renderers. */
const BY_KEY = new Map(RAIL_ICONS.map((i) => [i.key, i]));

export const BUILTIN_PREFIX = "builtin:";

/**
 * Resolve a stored `icon` value into something renderable.
 *
 * Returns the viewBox and path whether the row holds `builtin:<key>` or a
 * pasted path, so a caller never has to branch on which kind it is. An unknown
 * builtin key falls back to the globe rather than rendering nothing — a row
 * with a missing glyph should still be clickable, not invisible.
 */
export function resolveRailIcon(
  icon: string | null | undefined,
  viewBox?: string | null,
): { viewBox: string; path: string } {
  const raw = (icon || "").trim();

  if (raw.startsWith(BUILTIN_PREFIX)) {
    const found = BY_KEY.get(raw.slice(BUILTIN_PREFIX.length));
    if (found) return { viewBox: found.viewBox, path: found.path };
    return { viewBox: BY_KEY.get("globe")!.viewBox, path: BY_KEY.get("globe")!.path };
  }

  if (raw) return { viewBox: (viewBox || "").trim() || "0 0 24 24", path: raw };

  return { viewBox: BY_KEY.get("globe")!.viewBox, path: BY_KEY.get("globe")!.path };
}

/** True when the stored value names one of the built-ins. */
export function isBuiltinIcon(icon: string | null | undefined): boolean {
  return (icon || "").trim().startsWith(BUILTIN_PREFIX);
}
