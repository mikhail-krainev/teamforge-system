import { useState } from 'react';

/**
 * Local edits of a form, kept apart from the saved values: a field shows its draft when there is
 * one. `resetSignal` changes after a save, which drops the drafts (state adjusted during render,
 * so the focused control is not remounted).
 */
export function useDraft<Fields extends Record<string, string>>(resetSignal: number) {
  const [draft, setDraft] = useState<Partial<Fields>>({});
  const [seenSignal, setSeenSignal] = useState(resetSignal);
  if (seenSignal !== resetSignal) {
    setSeenSignal(resetSignal);
    setDraft({});
  }
  const setField = (field: keyof Fields, value: string) =>
    setDraft((previous) => ({ ...previous, [field]: value }));
  return { draft, setField } as const;
}
