'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { checklistRootKey, type ChecklistItem } from '@/features/route/api';
import { runItemWrite, type ItemWrite } from './api';
import { currentFromConflict, isVersionConflict } from './conflict';

export interface ItemConflict {
  write: ItemWrite;
  /** The item as the server sent it with the 409; `null` when the item prop (re-read) should be used. */
  current: ChecklistItem | null;
}

interface Variables {
  write: ItemWrite;
  version: number;
}

interface Handlers {
  onSaved: () => void;
  onConflict: (conflict: ItemConflict) => void;
}

/** The mutation behind every write: caches the saved item, re-reads the checklist on a conflict. */
function useWriteMutation(teamId: string, itemId: string, handlers: Handlers) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (variables: Variables, key) =>
      runItemWrite({ teamId, itemId }, variables.write, variables.version, key),
    onSuccess: (updated) => {
      queryClient.setQueriesData<ChecklistItem[]>({ queryKey: checklistRootKey(teamId) }, (items) =>
        items?.map((item) => (item.id === updated.id ? updated : item)),
      );
      handlers.onSaved();
    },
    onError: (error, variables) => {
      if (!isVersionConflict(error)) return;
      handlers.onConflict({ write: variables.write, current: currentFromConflict(error) });
      void queryClient.invalidateQueries({ queryKey: checklistRootKey(teamId) });
    },
  });
}

/**
 * All writes of one checklist item go through here. The version comes from the item the user sees;
 * a 409 VERSION_CONFLICT keeps the write so that it can be re-sent against the actual version
 * ("apply my changes again") instead of being lost.
 */
export function useItemWrites(teamId: string, item: ChecklistItem) {
  const [conflict, setConflict] = useState<ItemConflict | null>(null);
  /** Bumped after every successful write: drafts of the item's forms reset to the saved values. */
  const [savedCount, setSavedCount] = useState(0);
  /** A problem found on the client before anything was sent (an invalid link, a short text). */
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = useWriteMutation(teamId, item.id, {
    onSaved: () => {
      setConflict(null);
      setSavedCount((count) => count + 1);
    },
    onConflict: setConflict,
  });

  /** Resolves to whether the write was saved; failures are exposed through `error` / `conflict`. */
  function send(write: ItemWrite, version: number): Promise<boolean> {
    setProblem(null);
    return mutation.mutateAsync({ write, version }).then(
      () => true,
      () => false,
    );
  }

  return {
    submit: (write: ItemWrite) => {
      setConflict(null);
      return send(write, item.version);
    },
    reapply: () => {
      if (!conflict) return Promise.resolve(false);
      return send(conflict.write, (conflict.current ?? item).version);
    },
    dismissConflict: () => {
      setConflict(null);
      mutation.reset();
    },
    /** Reports a client-side problem; an earlier server failure is dropped so one message shows. */
    reportProblem: (text: string) => {
      mutation.reset();
      setProblem(text);
    },
    problem,
    pending: mutation.isPending,
    /** The failure to show; a version conflict has its own panel. */
    error: mutation.isError && !isVersionConflict(mutation.error) ? mutation.error : null,
    conflict,
    savedCount,
  };
}

export type ItemWrites = ReturnType<typeof useItemWrites>;
