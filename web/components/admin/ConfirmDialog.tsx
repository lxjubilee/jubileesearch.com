'use client';

// The console's confirm dialog, in place of window.confirm().
//
// The browser's box could not be styled, announced itself as
// "jubileesearch.com says", and put the consequences of a purge in the same
// grey line as the question. This is a native <dialog>: focus is trapped,
// Escape cancels, the page behind is inert -- and it is drawn in the console's
// own palette, with the destructive answer coloured as such.
//
// The messages the console already passes are shaped "Question?\n\nWhat will
// happen." That shape is kept: the first paragraph is the title, the rest is
// the body, so no call site had to be rewritten.
//
// `useConfirm()` returns an async `confirm(message, options)` that resolves
// true or false, plus the element to render once. Callers await it exactly
// where they used to call window.confirm.

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './ConfirmDialog.module.css';

export interface ConfirmOptions {
  /** Colours the confirming button. Danger is for anything that deletes. */
  tone?: 'primary' | 'danger';
  confirmLabel?: string;
  cancelLabel?: string;
}

interface Pending {
  message: string;
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function useConfirm(): [
  (message: string, options?: ConfirmOptions) => Promise<boolean>,
  React.ReactNode,
] {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback((message: string, options: ConfirmOptions = {}) =>
    new Promise<boolean>((resolve) => { setPending({ message, options, resolve }); }), []);

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const element = pending
    ? <ConfirmDialog message={pending.message} options={pending.options} onSettle={settle} />
    : null;

  return [confirm, element];
}

export function ConfirmDialog(
  { message, options, onSettle }:
  { message: string; options: ConfirmOptions; onSettle: (ok: boolean) => void },
) {
  const ref = useRef<HTMLDialogElement>(null);
  // Set when a button is pressed, so the dialog's close event can tell a
  // choice from an Escape or a backdrop click, both of which mean "no".
  const answer = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const [title, ...rest] = message.split(/\n\s*\n/);
  const body = rest.join('\n\n').trim();
  const tone = options.tone ?? 'primary';

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="confirm-title"
      onClose={() => onSettle(answer.current)}
      onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
    >
      <div className={styles.panel} data-tone={tone}>
        <div className={styles.head}>
          <span className={styles.mark} aria-hidden="true">
            {tone === 'danger' ? (
              <svg viewBox="0 0 24 24"><path d="M12 3 2 21h20L12 3zm0 5.5 6.5 11h-13L12 8.5zM11 11v4h2v-4h-2zm0 5v2h2v-2h-2z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 3v2h2V7h-2zm0 4v6h2v-6h-2z" /></svg>
            )}
          </span>
          <h2 id="confirm-title" className={styles.title}>{title?.trim()}</h2>
        </div>

        {body && <p className={styles.body}>{body}</p>}

        <div className={styles.actions}>
          <button
            type="button"
            className="btn"
            onClick={() => { answer.current = false; ref.current?.close(); }}
          >
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className="btn"
            data-tone={tone}
            autoFocus
            onClick={() => { answer.current = true; ref.current?.close(); }}
          >
            {options.confirmLabel ?? (tone === 'danger' ? 'Yes, do it' : 'Continue')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
