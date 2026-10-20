import type { StepRoles } from './route-plan.js';

/** Pure rules of the checklist item writes (FR-WORK-03..07): no I/O, so they are unit-tested directly. */

export interface ItemFacts {
  kind: string;
  submission: string | null;
  linkUrl: string | null;
  heldOn: string | null;
  externalUrl: string | null;
  outcome: string | null;
  /** Files of the item that are not deleted. */
  filesCount: number;
}

export interface CompletionIssue {
  /** `RITUAL_FIELDS_REQUIRED` for a ritual, `VALIDATION_FAILED` for the other refusals (both 422). */
  code: 'RITUAL_FIELDS_REQUIRED' | 'VALIDATION_FAILED';
  pointers: string[];
  message: string;
}

const present = (value: string | null): boolean => value !== null && value.trim() !== '';

const DAY_MS = 86_400_000;

/** The day after `day` (`YYYY-MM-DD`, UTC). */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * The day a ritual was held must lie between the day its stage opened and today (FR-WORK-06). The
 * server counts days in UTC, so a member east of it can hold the meeting on "tomorrow": one day ahead is allowed.
 */
export function heldOnIssue(
  heldOn: string,
  context: { today: string; stageOpenedOn: string | null },
): CompletionIssue | undefined {
  const late = heldOn > nextDay(context.today);
  const early = context.stageOpenedOn !== null && heldOn < context.stageOpenedOn;
  if (!late && !early) return undefined;
  return {
    code: 'VALIDATION_FAILED',
    pointers: ['/heldOn'],
    message: late
      ? 'The day of the ritual is more than a day ahead'
      : 'The day of the ritual is before the stage',
  };
}

/**
 * What an item still lacks to be closed (FR-WORK-05, -06): a ritual needs the day, an external
 * link and the outcome; an artifact needs what its step asks for (a link, a file or either).
 */
export function completionIssue(
  facts: ItemFacts,
  context: { today: string; stageOpenedOn: string | null },
): CompletionIssue | undefined {
  if (facts.kind === 'ritual') {
    const { heldOn } = facts;
    const missing = [
      present(heldOn) ? undefined : '/heldOn',
      present(facts.externalUrl) ? undefined : '/externalUrl',
      present(facts.outcome) ? undefined : '/outcome',
    ].filter((p): p is string => p !== undefined);
    // `heldOn === null` always has '/heldOn' in `missing`; it is here so that `heldOn` is a string below.
    if (missing.length > 0 || heldOn === null) {
      return {
        code: 'RITUAL_FIELDS_REQUIRED',
        pointers: missing,
        message: 'A ritual is closed with the day, an external link and the outcome',
      };
    }
    return heldOnIssue(heldOn, context);
  }
  const hasLink = present(facts.linkUrl);
  const hasFile = facts.filesCount > 0;
  const ok =
    facts.submission === 'link'
      ? hasLink
      : facts.submission === 'file'
        ? hasFile
        : hasLink || hasFile;
  if (ok) return undefined;
  const pointer =
    facts.submission === 'link' ? '/linkUrl' : facts.submission === 'file' ? '/files' : '/linkUrl';
  return {
    code: 'VALIDATION_FAILED',
    pointers: [pointer],
    message: 'An artifact is closed with what the step asks for',
  };
}

/** The role under which an executor carries a step: the owner role, else the first alternative he holds. */
export function executorRole(step: StepRoles, roles: readonly string[]): string | null {
  if (roles.includes(step.ownerRole)) return step.ownerRole;
  return step.altRoles.find((r) => roles.includes(r)) ?? null;
}

/**
 * FR-TEAM-11, FR-WORK-02: when a member leaves, the step of the role nobody holds any more goes
 * to the fallback; a step that did not use it is never moved back by itself (the lead decides).
 */
export function fallbackAfterDeparture(
  step: StepRoles,
  currentlyUsed: boolean,
  holders: readonly { roles: readonly string[] }[],
): boolean {
  if (currentlyUsed) return true;
  if (step.ownerRole === 'any') return false;
  const wanted = [step.ownerRole, ...step.altRoles];
  return !holders.some((m) => m.roles.some((r) => wanted.includes(r)));
}
