// The route of a started project: stages, checklist items with what was handed in, and GitHub work.
import {
  ISSUE_TITLES,
  MEETING_URLS,
  PR_TITLES,
  RITUAL_OUTCOMES,
  artifactLink,
} from './content.mjs';
import { GITHUB_ID_BASE, HOUR_MS, dateOnly } from './world.mjs';

export const INSTALLATION_ID = GITHUB_ID_BASE + 1;
const GITHUB_ORG = 'teamforge-demo';
const CODE_ROLES = new Set([
  'frontend',
  'backend',
  'devops',
  'mobile',
  'qa',
  'ml_engineer',
  'data_engineer',
]);

/** FR-WORK-02, as in workspace/internal/domain/route-plan.ts: who carries a step when its stage opens. */
function chooseExecutor(step, members) {
  if (step.ownerRole === 'any') return { member: null, role: null, fallback: false };
  const holders = (roles) => members.filter((m) => m.roles.some((r) => roles.includes(r)));
  const owners = holders([step.ownerRole]);
  if (owners.length === 1) return { member: owners[0], role: step.ownerRole, fallback: false };
  if (owners.length > 1) return { member: null, role: null, fallback: false };
  const alternatives = holders(step.altRoles);
  if (alternatives.length === 1) {
    const role = step.altRoles.find((r) => alternatives[0].roles.includes(r));
    return { member: alternatives[0], role, fallback: false };
  }
  return { member: null, role: null, fallback: alternatives.length === 0 };
}

export function buildWork(world, team) {
  if (!team.startedAt) return;
  team.repo = addRepository(world, team);
  team.contributions = [];
  team.playbook.stages.forEach((stage, i) => {
    const times = team.timeline[i];
    const status = times.closedAt ? 'closed' : times.openedAt ? 'open' : 'pending';
    const stageId = world.id();
    world.add('workspace.project_stage', {
      id: stageId,
      team_id: team.id,
      stage_key: stage.key,
      ordinal: stage.ordinal,
      title: stage.title,
      duration_days: stage.durationDays,
      status,
      opened_at: times.openedAt,
      due_at: times.openedAt
        ? new Date(times.openedAt.getTime() + stage.durationDays * 86_400_000)
        : null,
      closed_at: times.closedAt,
      closed_by: times.closedAt ? team.creator.userId : null,
      version: status === 'pending' ? 1 : status === 'open' ? 2 : 3,
      suspended_applied_seconds: 0,
    });
    if (status === 'pending') return;
    const progress = status === 'closed' ? 1 : team.bp.progress;
    const end = times.closedAt ?? world.now;
    stage.steps.forEach((step, n) => {
      const nobodyFits = !step.required && chooseExecutor(step, team.members).fallback;
      const scheduled =
        status === 'closed'
          ? step.required || world.chance(0.5)
          : n < Math.round(progress * stage.steps.length);
      const done = scheduled && !nobodyFits;
      addItem(world, team, { stage, stageId, step, done, openedAt: times.openedAt, end, n });
    });
  });
  if (team.repo) addGithubWork(world, team);
}

/** Who closed a step without a single executor: a holder of its roles, else the lead runs rituals and anyone hands in artifacts. */
function memberFor(world, team, step) {
  const wanted = step.ownerRole === 'any' ? [] : [step.ownerRole, ...step.altRoles];
  const fit = team.members.filter((m) => m.roles.some((r) => wanted.includes(r)));
  if (fit.length > 0) return world.pick(fit);
  const lead = team.members.find((m) => m.isLead) ?? team.members[0];
  return step.kind === 'ritual' && world.chance(0.7) ? lead : world.pick(team.members);
}

function addItem(world, team, { stage, stageId, step, done, openedAt, end, n }) {
  const executor = chooseExecutor(step, team.members);
  const itemId = world.id();
  const span = end.getTime() - openedAt.getTime();
  const doneAt = new Date(
    openedAt.getTime() + span * ((n + 0.6 + world.random() * 0.3) / (stage.steps.length + 1)),
  );
  const doer = done ? (executor.member ?? memberFor(world, team, step)) : null;
  const facts = done ? submissionFacts(world, team, step, doneAt) : {};
  world.add(
    'workspace.checklist_item',
    itemRow({ team, stageId, step, executor, itemId, done, doneAt, doer, facts, openedAt }),
  );
  if (!done) return;
  if (step.kind === 'artifact' && step.submission === 'file')
    addFile(world, team, itemId, step, doer, doneAt);
  if (step.reviewItems > 0) addReviewAnswers(world, team, itemId, step, doer, doneAt);
  addItemContribution(world, team, {
    stage,
    step,
    itemId,
    role: executor.role ?? doer.roles[0],
    doer,
    doneAt,
  });
}

function itemRow({ team, stageId, step, executor, itemId, done, doneAt, doer, facts, openedAt }) {
  return {
    id: itemId,
    team_id: team.id,
    project_stage_id: stageId,
    step_key: step.key,
    kind: step.kind,
    submission: step.submission,
    ritual_kind: step.ritualKind,
    required: step.required,
    owner_role: step.ownerRole,
    alt_roles: step.altRoles,
    status: done ? 'done' : 'open',
    assignee_user_id: executor.member?.person.userId ?? null,
    role_code: executor.role,
    fallback_used: executor.fallback,
    link_url: facts.linkUrl ?? null,
    link_status: facts.linkUrl ? 'ok' : 'none',
    link_checked_at: facts.linkUrl ? new Date(doneAt.getTime() + HOUR_MS) : null,
    held_on: facts.heldOn ?? null,
    external_url: facts.externalUrl ?? null,
    outcome: facts.outcome ?? null,
    done_by: doer?.person.userId ?? null,
    done_at: done ? doneAt : null,
    version: done ? 3 : 1,
    updated_at: done ? doneAt : openedAt,
    unassigned_from_user_id: null,
  };
}

function addItemContribution(world, team, { stage, step, itemId, role, doer, doneAt }) {
  team.contributions.push(
    world.add('workspace.contribution', {
      id: world.id(),
      team_id: team.id,
      user_id: doer.person.userId,
      source: step.kind,
      ref: `item:${itemId}`,
      title: step.title,
      url: null,
      role_code: role,
      role_locked: false,
      stage_ordinal: stage.ordinal,
      active: true,
      occurred_at: doneAt,
      received_at: doneAt,
    }),
  );
}

function submissionFacts(world, team, step, doneAt) {
  if (step.kind === 'ritual') {
    return {
      heldOn: dateOnly(doneAt),
      externalUrl: `${world.pick(MEETING_URLS)}${team.bp.slug}-${step.key}`,
      outcome: world.pick(RITUAL_OUTCOMES),
    };
  }
  if (step.submission === 'file') return {};
  const repoUrl = team.repo?.url ?? `https://github.com/${GITHUB_ORG}/${team.bp.slug}`;
  return {
    linkUrl: artifactLink(
      step.key,
      repoUrl,
      `https://${team.bp.slug}-demo.vercel.app`,
      team.bp.slug,
    ),
  };
}

function addFile(world, team, itemId, step, doer, doneAt) {
  const size = world.int(40, 900) * 1024;
  world.add('workspace.artifact_file', {
    id: world.id(),
    team_id: team.id,
    checklist_item_id: itemId,
    storage_key: `demo/${team.id}/${itemId}.pdf`,
    sha256: world.bytes(`file:${itemId}`),
    size_bytes: size,
    mime: 'application/pdf',
    original_name: `${step.key.replace(/^[wm]\d_/, '')}.pdf`,
    uploaded_by: doer.person.userId,
    created_at: doneAt,
    deleted_at: null,
  });
  team.storage = {
    files: (team.storage?.files ?? 0) + 1,
    bytes: (team.storage?.bytes ?? 0) + size,
  };
}

/** Review checklist of the step: another member answers; now and then a "no" is accepted as a risk. */
function addReviewAnswers(world, team, itemId, step, doer, doneAt) {
  const others = team.members.filter((m) => m !== doer);
  const reviewer = (others.find((m) => m.isLead) ?? others[0] ?? doer).person;
  for (let ordinal = 1; ordinal <= step.reviewItems; ordinal += 1) {
    const answer = !world.chance(0.08);
    const answeredAt = new Date(doneAt.getTime() - world.between(1, 6) * HOUR_MS);
    world.add('workspace.review_answer', {
      checklist_item_id: itemId,
      ordinal,
      reviewer_user_id: reviewer.userId,
      answer,
      answered_at: answeredAt,
    });
    if (!answer) {
      world.add('workspace.review_risk', {
        checklist_item_id: itemId,
        ordinal,
        reason: 'Не успеваем в этом этапе, вернёмся после релиза.',
        accepted_by: reviewer.userId,
        accepted_at: answeredAt,
      });
    }
  }
}

/** A repository is linked once the team gets to code: web from the architecture stage, ML from the baseline. */
function addRepository(world, team) {
  const codeStage = team.bp.type === 'web_service' ? 5 : 4;
  const reached = team.bp.status === 'completed' || team.bp.stage >= codeStage;
  if (!reached) return null;
  const repositoryId = GITHUB_ID_BASE + 10_000 + world.counter;
  const fullName = `${GITHUB_ORG}/${team.bp.slug}`;
  const linkedAt = team.timeline[codeStage - 1].openedAt;
  world.add('github.repo_link', {
    id: world.id(),
    team_id: team.id,
    repository_id: repositoryId,
    installation_id: INSTALLATION_ID,
    full_name: fullName,
    is_private: false,
    is_fork: false,
    repo_created_at: new Date(linkedAt.getTime() - 2 * HOUR_MS),
    status: team.completedAt ? 'completed' : 'active',
    linked_by: team.creator.userId,
    linked_at: linkedAt,
    unlinked_at: null,
    unlink_reason: null,
  });
  world.add('github.installation_grant', {
    installation_id: INSTALLATION_ID,
    team_id: team.id,
    user_id: team.creator.userId,
    granted_at: linkedAt,
    revoked_at: null,
  });
  world.add('github.repo_sync_state', {
    repository_id: repositoryId,
    last_synced_at: world.ago(0.01),
    ci_state: 'success',
    ci_checked_at: world.ago(0.01),
  });
  return { id: repositoryId, fullName, url: `https://github.com/${fullName}`, linkedAt };
}

function stageOrdinalAt(team, when) {
  const index = team.timeline.findIndex(
    (t) => t.openedAt && t.openedAt <= when && (!t.closedAt || t.closedAt > when),
  );
  return index === -1 ? null : index + 1;
}

/** Issues and pull requests of the coders, their reviews, and the contributions they count as. */
function addGithubWork(world, team) {
  const coders = team.members.filter(
    (m) => m.person.githubUserId && m.roles.some((r) => CODE_ROLES.has(r)),
  );
  const work = {
    coders,
    end: team.completedAt ?? world.now,
    fewPrs: team.bp.fraud === 'open-dispute' || team.bp.fraud === 'decided-violation',
    number: 0,
  };
  for (const coder of coders) {
    const role = coder.roles.find((r) => CODE_ROLES.has(r));
    const prCount = work.fewPrs ? (coder.isLead ? 3 : 0) : world.int(3, 8);
    for (let i = 0; i < prCount; i += 1) addPullRequest(world, team, work, coder, role);
    if (work.fewPrs) continue;
    for (let i = 0; i < world.int(1, 3); i += 1) addIssue(world, team, work, coder, role);
  }
}

/** A pull request; a merged one is approved by another coder and counts as a contribution. */
function addPullRequest(world, team, work, coder, role) {
  work.number += 1;
  const number = work.number;
  const openedAt = world.during(team.repo.linkedAt, work.end);
  const merged = openedAt.getTime() < work.end.getTime() - 8 * HOUR_MS || world.chance(0.3);
  const mergedAt = merged
    ? new Date(Math.min(openedAt.getTime() + world.between(3, 40) * HOUR_MS, work.end.getTime()))
    : null;
  const title = world.pick(PR_TITLES[role]);
  const fewPrs = work.fewPrs;
  addGhItem(world, team, {
    kind: 'pr',
    number,
    title,
    author: coder,
    openedAt,
    closedAt: mergedAt,
    merged,
    fewPrs,
  });
  if (!merged) return;
  const reviewer = work.coders.find((c) => c !== coder);
  if (reviewer) {
    world.add('github.gh_pr_review', {
      repository_id: team.repo.id,
      pr_number: number,
      reviewer_github_id: reviewer.person.githubUserId,
      state: 'approved',
      submitted_at: new Date(mergedAt.getTime() - HOUR_MS),
    });
  }
  addCodeContribution(world, team, coder, role, 'pr', number, title, mergedAt);
}

function addIssue(world, team, work, coder, role) {
  work.number += 1;
  const number = work.number;
  const openedAt = world.during(team.repo.linkedAt, work.end);
  const closedAt = world.chance(0.7)
    ? new Date(Math.min(openedAt.getTime() + world.between(5, 72) * HOUR_MS, work.end.getTime()))
    : null;
  const title = world.pick(ISSUE_TITLES);
  addGhItem(world, team, {
    kind: 'issue',
    number,
    title,
    author: coder,
    openedAt,
    closedAt,
    merged: false,
  });
  if (closedAt) addCodeContribution(world, team, coder, role, 'issue', number, title, closedAt);
}

function addGhItem(
  world,
  team,
  { kind, number, title, author, openedAt, closedAt, merged, fewPrs },
) {
  world.add('github.gh_item', {
    repository_id: team.repo.id,
    kind,
    number,
    title,
    html_url: `${team.repo.url}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    author_github_id: author.person.githubUserId,
    assignee_github_ids: [author.person.githubUserId],
    closer_pr_number: null,
    state: closedAt ? 'closed' : 'open',
    merged,
    labels: kind === 'issue' ? ['bug'] : [],
    additions: kind === 'pr' ? (fewPrs ? world.int(2, 12) : world.int(20, 400)) : null,
    deletions: kind === 'pr' ? world.int(0, 80) : null,
    closed_at: closedAt,
    merged_at: merged ? closedAt : null,
    first_received_at: openedAt,
    updated_at: closedAt ?? openedAt,
    source_updated_at: closedAt ?? openedAt,
  });
}

function addCodeContribution(world, team, member, role, source, number, title, when) {
  team.contributions.push(
    world.add('workspace.contribution', {
      id: world.id(),
      team_id: team.id,
      user_id: member.person.userId,
      source,
      ref: `${source}:${team.repo.id}#${number}`,
      title,
      url: `${team.repo.url}/${source === 'pr' ? 'pull' : 'issues'}/${number}`,
      role_code: role,
      role_locked: false,
      stage_ordinal: stageOrdinalAt(team, when),
      active: true,
      occurred_at: when,
      received_at: when,
    }),
  );
}
