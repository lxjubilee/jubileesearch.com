import type { ReactNode } from 'react';

// The console's shared furniture. Server components, no state.

export function PageHead({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <header className="head">
      <h1 className="h1">{title}</h1>
      {sub && <p className="sub">{sub}</p>}
    </header>
  );
}

export function Panel(
  { title, note, children }: { title?: string; note?: ReactNode; children: ReactNode },
) {
  return (
    <section className="panel">
      {(title || note) && (
        <div className="panelHead">
          {title && <h2 className="panelTitle">{title}</h2>}
          {note && <span className="panelNote">{note}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'accent' | 'neutral';

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className="pill" data-tone={tone === 'neutral' ? undefined : tone}>{children}</span>;
}

export function Tile(
  { label, value, state, foot }:
  { label: string; value: ReactNode; state?: 'good' | 'warn' | 'bad'; foot?: ReactNode },
) {
  return (
    <div className="tile">
      <p className="tileLabel">{label}</p>
      <div className="tileValue" data-state={state}>{value}</div>
      {foot && <div className="tileFoot">{foot}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Notice({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <div className="notice" data-tone={tone === 'neutral' ? undefined : tone}>{children}</div>;
}

/**
 * What a screen shows when the engine refuses or cannot be reached.
 *
 * Named separately from the empty state on purpose: "there is nothing here" and
 * "we could not find out" are different facts, and an operator acting on the
 * first when the second is true is the failure mode worth designing against.
 */
export function LoadFailed({ what, detail }: { what: string; detail: string }) {
  return (
    <Notice tone="bad">
      <strong>{what} could not be loaded.</strong>{' '}
      <span className="mono">{detail}</span>
      <div style={{ marginTop: 6, color: 'var(--a-ink-dim)' }}>
        This is not an empty result — the console does not know the answer. Nothing on this
        screen should be read as a count.
      </div>
    </Notice>
  );
}

/** Postgres timestamps, rendered short and stable. */
export function when(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function ago(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
