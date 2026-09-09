'use client';

import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/admin-actions';

// A maintenance action with no form fields.
//
// The index tools take no input, so wrapping each in a <form> would be three
// empty forms. This calls the action directly in a transition and reports the
// result beneath itself, which is the only thing the operator needs back.

export function ToolButton(
  { action, children, confirm }:
  { action: () => Promise<ActionResult>; children: React.ReactNode; confirm?: string },
) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          start(async () => setResult(await action()));
        }}
      >
        {pending ? 'Working…' : children}
      </button>
      {result && (
        <span
          style={{
            fontSize: 12,
            color: result.ok ? 'var(--a-good)' : 'var(--a-bad)',
            maxWidth: 320,
            lineHeight: 1.5,
          }}
        >
          {result.message}
        </span>
      )}
    </span>
  );
}
