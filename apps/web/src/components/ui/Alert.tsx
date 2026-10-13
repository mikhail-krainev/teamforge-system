import type { ReactNode } from 'react';

type Tone = 'error' | 'info' | 'warn' | 'success';

/** Errors are announced assertively (`alert`), everything else politely (`status`). */
export function Alert({ tone, children, id }: { tone: Tone; children: ReactNode; id?: string }) {
  return (
    <div id={id} role={tone === 'error' ? 'alert' : 'status'} className={`alert alert-${tone}`}>
      {children}
    </div>
  );
}
