'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from '@/lib/admin-actions';

// Form plumbing for the console's writes.
//
// The result is shown in place rather than thrown, because an operator who has
// just typed a ranking weight or a review note should not have the page
// replaced by an error boundary and lose it.
//
// A pending action disables its own button. Every write here is one an operator
// could otherwise fire twice by double-clicking, and two of them -- purge and
// block -- are not things to do twice by accident.

type Action = (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;

export function ActionForm(
  { action, children, className }:
  { action: Action; children: React.ReactNode; className?: string },
) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);

  return (
    <form action={formAction} className={className}>
      {children}
      {state && (
        <div className="notice" data-tone={state.ok ? 'good' : 'bad'} style={{ marginTop: 12, marginBottom: 0 }}>
          {state.message}
        </div>
      )}
    </form>
  );
}

export function SubmitButton(
  { children, tone, name, value, confirm }:
  {
    children: React.ReactNode;
    tone?: 'primary' | 'danger' | 'good';
    name?: string;
    value?: string;
    /** Shown before a destructive submit. Absent means no prompt. */
    confirm?: string;
  },
) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      className="btn"
      data-tone={tone}
      name={name}
      value={value}
      disabled={pending}
      onClick={(e) => {
        // Progressive: with JavaScript off there is no prompt and the form still
        // submits. The prompt is a guard against a slip, not a permission check
        // -- the engine is what actually decides.
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}
