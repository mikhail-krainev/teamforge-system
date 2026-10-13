import { expect, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './axe';
import { onWebOrigin } from './mail';
import { bellUi, invitationUi, offerUi, ROUTES, teamFormUi, teamPageUi, voteUi } from './slice3-ui';
import {
  expireVotePhase,
  get,
  person,
  post,
  teamAs,
  world,
  type PersonKey,
  type TeamBody,
} from './slice3-world';

/** Step bodies of slice3.spec.ts (docs/plan.md, "Тесты среза" -> Playwright slice3.spec.ts, steps 1-8). */

const ROLE_LABELS = ['Backend-разработчик', 'Frontend-разработчик', 'QA-инженер'];

// ---- step 1: A creates a "Веб-сервис" team with 3 seats --------------------------------------

export async function formIsAccessible(): Promise<void> {
  const { page } = person('a').session;
  await page.goto(ROUTES.newTeam);
  await expect(teamFormUi.heading(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
}

export async function createTeamWithThreeSeats(): Promise<void> {
  const { page } = person('a').session;
  await page.goto(ROUTES.newTeam);
  await teamFormUi.name(page).fill(world.teamName);
  await teamFormUi.description(page).fill('Команда для сквозного сценария среза 3');
  await teamFormUi.productType(page).selectOption({ label: 'Веб-сервис' });
  await teamFormUi.hours(page).fill('10');
  for (const [index, role] of ROLE_LABELS.entries()) {
    await teamFormUi.addSeat(page).click();
    await teamFormUi.seatRole(page, index).selectOption({ label: role });
  }
  await teamFormUi.submit(page).click();
  await page.waitForURL(/\/teams\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  world.teamId = page.url().split('/').pop() ?? '';
  await expect(teamPageUi.title(page, world.teamName)).toBeVisible();
}

export async function teamPageShowsCreator(): Promise<void> {
  const a = person('a');
  const team = await teamAs(a);
  expect(team.leadUserId).toBe(a.id);
  expect(team.status).toBe('forming');
  expect(team.seats.filter((s) => s.status === 'open')).toHaveLength(3);
  await expect(teamPageUi.status(a.session.page)).toContainText(teamPageUi.statusText.forming);
  await expect(teamPageUi.member(a.session.page, a.name)).toBeVisible();
  await expectNoSeriousA11yViolations(a.session.page);
}

// ---- step 2: A creates an invitation and copies the link ---------------------------------------

export async function createInvitationLink(): Promise<void> {
  const { page } = person('a').session;
  await page.goto(`${ROUTES.team(world.teamId)}/invitations`);
  await invitationUi.create(page).click();
  const link = invitationUi.link(page);
  await expect(link).toBeVisible();
  world.inviteLink = await link.inputValue();
  expect(world.inviteLink).toContain('/invite#');
  world.inviteToken = new URL(world.inviteLink).hash.replace(/^#/, '');
  expect(world.inviteToken.length).toBeGreaterThanOrEqual(43);
}

export async function copyTheLink(): Promise<void> {
  const { page, context } = person('a').session;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await invitationUi.copy(page).click();
  await expect(invitationUi.copied(page)).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(world.inviteLink);
  await expectNoSeriousA11yViolations(page);
}

// ---- step 3: B opens the link, sees the preview, accepts; A sees it live -------------------------

export async function bOpensTheLinkAndSeesThePreview(): Promise<void> {
  const b = person('b');
  const a = person('a');
  // A keeps the team page open: the new member and the notification must appear without a reload.
  await a.session.page.goto(ROUTES.team(world.teamId));
  await expect(teamPageUi.status(a.session.page)).toBeVisible();
  await b.session.page.goto('about:blank');
  await b.session.page.goto(onWebOrigin(world.inviteLink));
  await expect(invitationUi.heading(b.session.page)).toBeVisible();
  await expect(invitationUi.team(b.session.page, world.teamName)).toBeVisible();
  await expectNoSeriousA11yViolations(b.session.page);
}

export async function bAcceptsTheInvitation(): Promise<void> {
  const b = person('b');
  await invitationUi.accept(b.session.page).click();
  await b.session.page.waitForURL(new RegExp(`/teams/${world.teamId}$`), { timeout: 30_000 });
  const team = await teamAs(b);
  expect(team.members.map((m) => m.userId)).toContain(b.id);
  expect(team.memberCount).toBe(2);
}

export async function aSeesBLiveWithANotification(): Promise<void> {
  const a = person('a');
  const { page } = a.session;
  // No page.reload(): the WebSocket event invalidates the query (S3-10, S3-13).
  await expect(teamPageUi.member(page, person('b').name)).toBeVisible({ timeout: 20_000 });
  await expect(bellUi.unreadBadge(page)).toBeVisible({ timeout: 20_000 });
  await bellUi.button(page).click();
  await expect(bellUi.item(page, new RegExp(person('b').name, 'i')).first()).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.keyboard.press('Escape');
}

// ---- step 4: A offers a seat to C, C accepts ----------------------------------------------------

export async function aOffersASeatToC(): Promise<void> {
  const a = person('a');
  const c = person('c');
  const { page } = a.session;
  await page.goto(`${ROUTES.team(world.teamId)}/offers`);
  await offerUi.open(page).click();
  await offerUi.seat(page).selectOption({ index: 1 });
  await offerUi.userId(page).fill(c.id);
  await offerUi.send(page).click();
  await expect(offerUi.sent(page)).toBeVisible();
}

export async function cAcceptsTheOffer(): Promise<void> {
  const c = person('c');
  const { page } = c.session;
  await page.goto(ROUTES.myOffers);
  await expect(offerUi.heading(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await offerUi.accept(page).first().click();
  await expect(offerUi.joined(page)).toBeVisible();
  const mine = await get<{ items: { team: { id: string } }[] }>(c, '/v1/me/teams?status=current');
  expect(mine.body.items.map((i) => i.team.id)).toContain(world.teamId);
}

// ---- step 5: D and E accept offers for the last seat at the same moment -------------------------

export async function dAndEHoldOffersForTheLastSeat(): Promise<void> {
  const a = person('a');
  const team = await teamAs(a);
  const last = team.seats.find((s) => s.status === 'open');
  expect(last, 'one seat is still open').toBeDefined();
  for (const key of ['d', 'e'] as const) {
    const offer = await post(a, `/v1/teams/${world.teamId}/seat-offers`, {
      seatId: last?.id,
      userId: person(key).id,
    });
    expect(offer.status, offer.text).toBe(201);
    await person(key).session.page.goto(ROUTES.myOffers);
    await expect(offerUi.accept(person(key).session.page).first()).toBeVisible();
  }
}

export async function theyAcceptTogether(): Promise<void> {
  const d = person('d').session.page;
  const e = person('e').session.page;
  await Promise.all([offerUi.accept(d).first().click(), offerUi.accept(e).first().click()]);
  const outcome = async (page: Page): Promise<'joined' | 'taken'> => {
    await expect(offerUi.joined(page).or(offerUi.seatTaken(page))).toBeVisible({ timeout: 20_000 });
    return (await offerUi.joined(page).isVisible()) ? 'joined' : 'taken';
  };
  const results = await Promise.all([outcome(d), outcome(e)]);
  expect(results.filter((r) => r === 'joined')).toHaveLength(1);
  expect(results.filter((r) => r === 'taken')).toHaveLength(1);
  world.raceWinner = results[0] === 'joined' ? 'd' : 'e';
}

export async function theLoserGetsAClearMessage(): Promise<void> {
  const loser: PersonKey = world.raceWinner === 'd' ? 'e' : 'd';
  const { page } = person(loser).session;
  await expect(offerUi.seatTaken(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  const team = await teamAs(person('a'));
  expect(team.memberCount).toBe(4);
  expect(team.seats.filter((s) => s.status === 'open')).toHaveLength(0);
}

// ---- step 6: A starts the project -----------------------------------------------------------------

export async function aStartsTheProject(): Promise<void> {
  const { page } = person('a').session;
  await page.goto(ROUTES.team(world.teamId));
  await teamPageUi.start(page).click();
  const confirm = teamPageUi.startConfirm(page);
  if (await confirm.isVisible()) await confirm.click();
  await expect(teamPageUi.status(page)).toContainText(teamPageUi.statusText.active);
  const team = await teamAs(person('a'));
  expect(team.status).toBe('active');
  expect(team.startedAt).toBeTruthy();
  await expectNoSeriousA11yViolations(page);
}

// ---- step 7: A leaves, the vote runs, B becomes the lead ------------------------------------------

export async function aLeavesAndTheVoteOpens(): Promise<void> {
  const a = person('a');
  await a.session.page.goto(ROUTES.team(world.teamId));
  await teamPageUi.leave(a.session.page).click();
  await teamPageUi.leaveConfirm(a.session.page).click();
  await a.session.page.waitForURL((url) => !url.pathname.startsWith(`/teams/${world.teamId}`), {
    timeout: 30_000,
  });
  const b = person('b');
  await b.session.page.goto(ROUTES.vote(world.teamId));
  await expect(voteUi.heading(b.session.page)).toBeVisible();
  await expect(voteUi.phase(b.session.page)).toContainText(voteUi.phaseText.nominating);
  await expect(voteUi.deadline(b.session.page)).toBeVisible();
  await expectNoSeriousA11yViolations(b.session.page);
}

export async function bNominatesHimself(): Promise<void> {
  const { page } = person('b').session;
  await voteUi.nominateSelf(page).click();
  await voteUi.consent(page).click();
  const votes = await get<{
    items: { status: string; candidates: { userId: string; confirmed: boolean }[] }[];
  }>(person('b'), `/v1/teams/${world.teamId}/leader-votes`);
  expect(votes.body.items[0]?.candidates).toEqual([
    expect.objectContaining({ userId: person('b').id, confirmed: true }),
  ]);
}

export async function theNominationPeriodEnds(): Promise<void> {
  expireVotePhase(world.teamId, 'nominating');
  // The worker scans overdue phases every minute (architecture 8.3); the phase change is announced via aria-live.
  const { page } = person('b').session;
  await expect(voteUi.phase(page)).toContainText(voteUi.phaseText.voting, { timeout: 150_000 });
  await expectNoSeriousA11yViolations(page);
}

export async function bAndCVoteForB(): Promise<void> {
  const b = person('b');
  const c = person('c');
  await voteUi.voteFor(b.session.page, b.name).click();
  await expect(voteUi.voted(b.session.page)).toBeVisible();
  await c.session.page.goto(ROUTES.vote(world.teamId));
  await voteUi.voteFor(c.session.page, b.name).click();
  await expect(voteUi.voted(c.session.page)).toBeVisible();
  // 2 of 3 is more than N/2: the vote closes early and asks the winner to confirm (FR-TEAM-17).
  await expect(voteUi.phase(b.session.page)).toContainText(voteUi.phaseText.confirming, {
    timeout: 20_000,
  });
}

export async function bConfirmsAndBecomesTheLead(): Promise<void> {
  const b = person('b');
  const { page } = b.session;
  await voteUi.respondAccept(page).click();
  await expect(voteUi.phase(page)).toContainText(voteUi.phaseText.closed, { timeout: 20_000 });
  const team: TeamBody = await teamAs(b);
  expect(team.leadUserId).toBe(b.id);
  expect(team.status).toBe('active');
  await page.goto(ROUTES.team(world.teamId));
  await expect(teamPageUi.status(page)).toContainText(teamPageUi.statusText.active);
  await expectNoSeriousA11yViolations(page);
}

// ---- step 8: axe on every page of the slice ---------------------------------------------------------

export async function everyPageOfTheSliceIsAccessible(): Promise<void> {
  const b = person('b').session.page;
  const pages = [
    ROUTES.teams,
    ROUTES.newTeam,
    ROUTES.team(world.teamId),
    ROUTES.vote(world.teamId),
    ROUTES.myOffers,
  ];
  for (const path of pages) {
    await b.goto(path);
    await expect(b.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoSeriousA11yViolations(b);
  }
  await b.goto('about:blank');
  await b.goto(ROUTES.invite('x'.repeat(43)));
  await expect(b.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoSeriousA11yViolations(b);
}
