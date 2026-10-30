import { expect, type Page } from '@playwright/test';
import { apiGet } from './api';
import { signInContext, uniqueEmail } from './auth';
import { expectNoSeriousA11yViolations } from './axe';
import {
  escapeRegExp,
  experienceFields,
  profileUi,
  publicProfileUi,
  resumeUi,
  ROUTES,
} from './slice2-ui';
import {
  chooseFromCatalogs,
  myProfile,
  PROFILE,
  RESUME_PDF,
  sessions,
  world,
} from './slice2-world';

/** Steps of the profile, resume and public-profile parts of the scenario. */

export async function fillBasics(): Promise<void> {
  const { page, context } = sessions().ivan;
  await chooseFromCatalogs(context);
  await page.goto(ROUTES.profile);
  await expect(profileUi.name(page)).toBeVisible();
  await profileUi.name(page).fill(PROFILE.name);
  await profileUi.timezone(page).selectOption(PROFILE.timezone);
  await profileUi.hours(page).fill(PROFILE.hours);
  await profileUi.portfolio(page).fill(PROFILE.portfolio);
  await profileUi.strengths(page).fill(PROFILE.strength);
  await profileUi.weaknesses(page).fill(PROFILE.weakness);
}

export async function pickTwoRolesWithPriorities(): Promise<void> {
  const { page } = sessions().ivan;
  const [first, second] = world.roles;
  if (!first || !second) throw new Error('roles are not chosen');
  await profileUi.roleAdd(page).selectOption({ value: first.code });
  await profileUi.roleAdd(page).selectOption({ value: second.code });
  await profileUi.roleUp(page, second.name).click();
  await expect(profileUi.roleRows(page)).toHaveCount(2);
  await expect(profileUi.roleRows(page).nth(0)).toContainText(second.name);
  await profileUi.roleLevel(page, 0).selectOption('middle');
  await profileUi.roleLevel(page, 1).selectOption('junior');
}

export async function pickThreeStackTags(): Promise<void> {
  const { page } = sessions().ivan;
  for (const tag of world.tags) {
    await profileUi.stackSearch(page).fill(tag.name);
    await profileUi.stackTag(page, tag.name).check();
  }
  await profileUi.stackSearch(page).fill('');
}

export async function addOneExperience(): Promise<void> {
  const { page } = sessions().ivan;
  await profileUi.experienceAdd(page).click();
  const entry = profileUi.experienceEntry(page, 1);
  await experienceFields.title(entry).fill(PROFILE.experience.title);
  await experienceFields.description(entry).fill(PROFILE.experience.description);
  await experienceFields.from(entry).fill(PROFILE.experience.from);
  await experienceFields.to(entry).fill(PROFILE.experience.to);
}

export async function saveProfile(): Promise<void> {
  const { page, context } = sessions().ivan;
  const [first, second] = world.roles;
  await profileUi.save(page).click();
  await expect(profileUi.saved(page)).toBeVisible();
  const stored = await myProfile(context);
  expect(stored.displayName).toBe(PROFILE.name);
  expect(stored.timezone).toBe(PROFILE.timezone);
  expect(stored.hoursPerWeek).toBe(Number(PROFILE.hours));
  expect(stored.rolePrefs).toEqual([
    { roleCode: second?.code, level: 'middle' },
    { roleCode: first?.code, level: 'junior' },
  ]);
  expect([...stored.stack].sort()).toEqual(world.tags.map((t) => t.code).sort());
  expect(stored.experience).toHaveLength(1);
  expect(stored.experience[0]?.title).toBe(PROFILE.experience.title);
}

export async function reloadKeepsTheData(): Promise<void> {
  const { page } = sessions().ivan;
  const [first, second] = world.roles;
  await page.reload();
  await expect(profileUi.name(page)).toHaveValue(PROFILE.name);
  await expect(profileUi.hours(page)).toHaveValue(PROFILE.hours);
  await expect(profileUi.timezone(page)).toHaveValue(PROFILE.timezone);
  await expect(profileUi.roleRows(page)).toHaveCount(2);
  await expect(profileUi.roleRows(page).nth(0)).toContainText(second?.name ?? '');
  await expect(profileUi.roleRows(page).nth(1)).toContainText(first?.name ?? '');
  for (const tag of world.tags) await expect(profileUi.stackTag(page, tag.name)).toBeChecked();
  const title = experienceFields.title(profileUi.experienceEntry(page, 1));
  await expect(title).toHaveValue(PROFILE.experience.title);
  await expectNoSeriousA11yViolations(page);
}

async function uploadResumeAndWaitReady(page: Page): Promise<void> {
  await resumeUi.file(page).setInputFiles(RESUME_PDF);
  await resumeUi.upload(page).click();
  const status = resumeUi.status(page);
  // The parse runs in the isolated resume-worker container: the first run can be slow.
  await expect(status, 'resume parse status').toContainText(resumeUi.readyText, {
    timeout: 150_000,
  });
  await expect(status).toHaveAttribute('aria-live', /polite|assertive/);
}

async function expectResumeGone(): Promise<void> {
  const { context } = sessions().ivan;
  await expect
    .poll(
      async () => {
        const response = await apiGet<{ extractedText?: string | null }>(
          context.request,
          '/v1/me/resume',
        );
        return response.status === 404 ? 'gone' : (response.body?.extractedText ?? 'gone');
      },
      { message: 'the resume file and extracted text are deleted', timeout: 30_000 },
    )
    .toBe('gone');
}

export async function uploadPdfAndWaitForReady(): Promise<void> {
  const { page, context } = sessions().ivan;
  world.versionBeforeResume = (await myProfile(context)).version;
  await page.goto(ROUTES.profile);
  await expect(profileUi.name(page)).toBeVisible();
  await uploadResumeAndWaitReady(page);
}

export async function extractedTextIsPlainAndProfileUntouched(): Promise<void> {
  const { page, context } = sessions().ivan;
  // The extracted text is not shown; the assessment of it is.
  await expect(resumeUi.assessmentHeading(page)).toBeVisible();
  await expect(page.getByText(/Ivan Petrov\.\s+Backend developer/)).toHaveCount(0);
  const profile = await myProfile(context);
  expect(profile.version, 'nothing is applied before confirmation').toBe(world.versionBeforeResume);
}

export async function profileWithResumeIsAccessible(): Promise<void> {
  await expectNoSeriousA11yViolations(sessions().ivan.page);
}

export async function confirmSuggestedFieldWithoutKeepingTheFile(): Promise<void> {
  const { page, context } = sessions().ivan;
  const suggested = resumeUi.suggestions(page).getByRole('checkbox');
  const stackBox = resumeUi.suggestions(page).getByRole('checkbox', { name: /стек/i });
  const hasSuggestions = (await suggested.count()) > 0;
  if (hasSuggestions) {
    if ((await stackBox.count()) > 0) await stackBox.check();
    else await suggested.first().check();
  }
  await resumeUi.keepFile(page).uncheck();
  await resumeUi.confirm(page).click();
  await expect(resumeUi.confirm(page)).toBeHidden();
  await expectResumeGone();
  if (!hasSuggestions) return;
  const profile = await myProfile(context);
  expect(profile.version, 'the confirmed field is applied').toBeGreaterThan(
    world.versionBeforeResume,
  );
}

export async function secondUploadCanBeDeleted(): Promise<void> {
  const { page } = sessions().ivan;
  await uploadResumeAndWaitReady(page);
  await resumeUi.remove(page).click();
  await resumeUi.removeConfirm(page).click();
  await expect(resumeUi.status(page)).not.toContainText(resumeUi.readyText);
  await expectResumeGone();
  await expectNoSeriousA11yViolations(page);
}

export async function guestIsSentToSignIn(): Promise<void> {
  const { page, context } = sessions().guest;
  await page.goto(ROUTES.user(world.ivanId));
  await expect(page).toHaveURL(new RegExp(escapeRegExp(ROUTES.signIn)));
  await expect(page.locator('body')).not.toContainText(PROFILE.name);
  const api = await apiGet(context.request, `/v1/users/${world.ivanId}/profile`);
  expect(api.status).toBe(401);
}

export async function secondUserSignsIn(): Promise<void> {
  const second = await signInContext(sessions().viewer.context, { email: uniqueEmail('viewer') });
  expect(second.id).not.toBe(world.ivanId);
}

export async function viewerSeesThePublicFields(): Promise<void> {
  const { page } = sessions().viewer;
  const stored = await myProfile(sessions().ivan.context);
  await page.goto(ROUTES.user(world.ivanId));
  await expect(publicProfileUi.name(page, stored.displayName)).toBeVisible();
  const main = page.getByRole('main');
  await expect(main).toContainText(PROFILE.timezone);
  await expect(main).toContainText(PROFILE.strength);
  for (const role of world.roles) await expect(main).toContainText(role.name);
  for (const tag of stored.stack) {
    await expect(main).toContainText(new RegExp(escapeRegExp(tag), 'i'));
  }
  await expectNoSeriousA11yViolations(page);
}

export async function viewerDoesNotSeeWeaknessesOrEmail(): Promise<void> {
  const { page, context } = sessions().viewer;
  const main = page.getByRole('main');
  await expect(main).not.toContainText(PROFILE.weakness);
  await expect(main).not.toContainText(world.ivanEmail);
  const url = `/v1/users/${world.ivanId}/profile`;
  const api = await apiGet<Record<string, unknown>>(context.request, url);
  expect(api.status, api.text).toBe(200);
  expect(api.text).not.toContain(PROFILE.weakness);
  expect(api.text.toLowerCase()).not.toContain(world.ivanEmail.toLowerCase());
  expect(Object.keys(api.body)).not.toContain('weaknesses');
  expect(Object.keys(api.body)).not.toContain('email');
}
