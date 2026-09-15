'use client';

// The "Report this result" dialog.
//
// This replaces a window.prompt(). The browser's own box looked like a
// system alert, said "jubileesearch.com says", and could not be styled to
// belong to the page. This is a native <dialog>, so focus is trapped, Escape
// closes it and the page behind is inert -- and it is drawn in the results
// page's own dark palette.
//
// It sends nothing itself: the parent owns the request, so the delegated
// telemetry listener in ResultTelemetry stays the one place that talks to the
// engine about a result.

import { useEffect, useRef, useState } from 'react';
import styles from './ReportDialog.module.css';

const MAX = 500;

export interface ReportDialogProps {
  /** The URL being reported; shown so the reader can see what they picked. */
  url: string;
  busy: boolean;
  error: string | null;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}

export default function ReportDialog({ url, busy, error, onSubmit, onClose }: ReportDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d || d.open) return;
    d.showModal();
  }, []);

  const trimmed = reason.trim();
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="report-title"
      onClose={onClose}
      onCancel={(e) => { if (busy) e.preventDefault(); }}
      // Clicking the backdrop closes it; the backdrop is the dialog element
      // itself outside the panel.
      onClick={(e) => { if (e.target === ref.current && !busy) ref.current?.close(); }}
    >
      <form
        method="dialog"
        className={styles.panel}
        onSubmit={(e) => { e.preventDefault(); if (trimmed && !busy) onSubmit(trimmed); }}
      >
        <h2 id="report-title" className={styles.title}>Report this result</h2>
        <p className={styles.lede}>
          Tell us what is wrong with the result from <strong className={styles.host}>{host}</strong>.
          A short reason is enough.
        </p>

        <label className={styles.label} htmlFor="report-reason">Reason</label>
        <textarea
          id="report-reason"
          className={styles.input}
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, MAX))}
          rows={3}
          maxLength={MAX}
          placeholder="For example: broken link, not about the topic, or content that should not be shown."
          autoFocus
          disabled={busy}
        />
        <div className={styles.meta}>
          <span className={styles.count} aria-live="polite">{reason.length}/{MAX}</span>
          {error && <span className={styles.error} role="alert">{error}</span>}
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => ref.current?.close()}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className={styles.primary} disabled={!trimmed || busy}>
            {busy ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
