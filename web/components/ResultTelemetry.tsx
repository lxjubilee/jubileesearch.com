'use client';

// Click logging and abuse reporting for the whole result list (R7, §11.3).
//
// One delegated listener rather than a handler on every card, which keeps
// ResultCard a server component and keeps the JavaScript this page ships
// roughly constant regardless of how many results are on it.
//
// Click logging is not optional decoration. §18's phase note: R7 "ships in
// Phase 3 even though the signal is not used until Phase 5. Data not collected
// is data that cannot be recovered." A click the engine never hears about is a
// gap in the position-bias correction that no later work can fill.

import { useEffect, useRef, useState } from 'react';
import type { Zone } from '@/lib/types';
import ReportDialog from './ReportDialog';

interface Reporting {
  url: string;
  button: HTMLButtonElement;
}

export default function ResultTelemetry({
  queryId,
  children,
}: {
  queryId: number | null;
  children: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);

  // The report in progress, if any. The dialog is rendered by this component
  // rather than by the card so the card can stay a server component; the
  // button that opened it is kept so its label can say what happened after.
  const [reporting, setReporting] = useState<Reporting | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const node = root.current;
    if (!node) return;

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      const link = target.closest('[data-result-link]');
      if (link) {
        const card = link.closest<HTMLElement>('.result-item');
        if (!queryId || !card) return;
        const { pageId, zone, position } = card.dataset;
        void fetch('/api/v1/event', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The navigation is already under way when this fires. Without
          // keepalive the browser cancels the request as the page unloads, and
          // every click on a result that actually took the reader somewhere --
          // which is every click worth learning from -- is lost.
          keepalive: true,
          body: JSON.stringify({
            query_id: queryId,
            page_id: Number(pageId),
            zone: zone as Zone,
            position: Number(position),
            type: 'click',
          }),
        }).catch(() => {});
        return;
      }

      const report = target.closest<HTMLButtonElement>('[data-report-url]');
      if (report && !report.disabled) {
        setError(null);
        setReporting({ url: report.dataset.reportUrl ?? '', button: report });
      }
    };

    node.addEventListener('click', onClick);
    return () => node.removeEventListener('click', onClick);
  }, [queryId]);

  const submit = async (reason: string) => {
    if (!reporting) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: reporting.url, reason }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // The engine tells the reporter nothing about whether the URL is in the
      // index or how many others have reported it -- that would be a probe of
      // the index dressed up as a form -- so the page says only that it arrived.
      reporting.button.textContent = 'Reported — thank you';
      reporting.button.disabled = true;
      setReporting(null);
    } catch {
      setError('The report could not be sent. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={root}>
      {children}
      {reporting && (
        <ReportDialog
          url={reporting.url}
          busy={busy}
          error={error}
          onSubmit={submit}
          onClose={() => { if (!busy) setReporting(null); }}
        />
      )}
    </div>
  );
}
