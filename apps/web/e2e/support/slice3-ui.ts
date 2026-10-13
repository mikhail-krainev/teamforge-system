import type { Locator, Page } from '@playwright/test';
import { escapeRegExp } from './slice2-ui';

/**
 * Routes, labels and accessible names that slice3.spec.ts relies on, in one place (role and label
 * locators with Russian regexes, no CSS classes). The routes are those of docs/plan.md S3-11..S3-13;
 * the texts are the expected contents of apps/web/src/i18n/ru/teams.json (and the votes, offers,
 * invitations, notifications dictionaries). The frontend task adapts the copy or tells the test
 * author which regex to loosen - when the UI copy changes, fix it here and only here.
 */
export const ROUTES = {
  teams: '/teams',
  newTeam: '/teams/new',
  team: (id: string): string => `/teams/${id}`,
  vote: (id: string): string => `/teams/${id}/vote`,
  /** Plan S3-12: the invitation page reads the token from the URL fragment. */
  invite: (token: string): string => `/invite#${token}`,
  /** Incoming offers of the signed-in user (listMySeatOffers). The plan gives no route: an assumption. */
  myOffers: '/offers',
} as const;

export const teamFormUi = {
  heading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /новая команда|создать команду/i }),
  name: (p: Page): Locator => p.getByLabel(/^название/i),
  description: (p: Page): Locator => p.getByLabel(/^описание/i),
  productType: (p: Page): Locator => p.getByLabel(/тип продукта/i),
  timezone: (p: Page): Locator => p.getByLabel(/часовой пояс/i),
  hours: (p: Page): Locator => p.getByLabel(/часов в неделю/i),
  addSeat: (p: Page): Locator => p.getByRole('button', { name: /добавить место/i }),
  seatRole: (p: Page, n: number): Locator => p.getByLabel(/^роль/i).nth(n),
  submit: (p: Page): Locator => p.getByRole('button', { name: /^создать команду$/i }),
};

export const teamPageUi = {
  title: (p: Page, name: string): Locator => p.getByRole('heading', { level: 1, name }),
  status: (p: Page): Locator => p.getByRole('status', { name: /статус команды/i }),
  statusText: { forming: /формируется/i, active: /активна/i, voting: /голосование/i },
  members: (p: Page): Locator => p.getByRole('region', { name: /участники/i }),
  member: (p: Page, displayName: string): Locator => teamPageUi.members(p).getByText(displayName),
  seats: (p: Page): Locator => p.getByRole('region', { name: /^места/i }),
  openSeats: (p: Page): Locator =>
    teamPageUi
      .seats(p)
      .getByRole('listitem')
      .filter({ hasText: /свободно|открыто/i }),
  start: (p: Page): Locator => p.getByRole('button', { name: /начать проект/i }),
  startConfirm: (p: Page): Locator => p.getByRole('button', { name: /да, начать/i }),
  leave: (p: Page): Locator => p.getByRole('button', { name: /выйти из команды/i }),
  leaveConfirm: (p: Page): Locator => p.getByRole('button', { name: /да, выйти/i }),
};

export const invitationUi = {
  create: (p: Page): Locator => p.getByRole('button', { name: /создать приглашение/i }),
  link: (p: Page): Locator => p.getByRole('textbox', { name: /ссылка приглашения/i }),
  copy: (p: Page): Locator => p.getByRole('button', { name: /скопировать/i }),
  copied: (p: Page): Locator => p.getByRole('status').filter({ hasText: /скопировано/i }),
  /** The /invite page: preview first, the action after. */
  heading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /приглашение в команду/i }),
  team: (p: Page, teamName: string): Locator => p.getByText(teamName),
  accept: (p: Page): Locator => p.getByRole('button', { name: /принять приглашение/i }),
};

export const offerUi = {
  /** Lead side: a seat, a user id and a message. */
  open: (p: Page): Locator => p.getByRole('button', { name: /предложить место/i }),
  seat: (p: Page): Locator => p.getByLabel(/^место$/i),
  userId: (p: Page): Locator => p.getByLabel(/идентификатор пользователя/i),
  send: (p: Page): Locator => p.getByRole('button', { name: /отправить предложение/i }),
  sent: (p: Page): Locator => p.getByText(/предложение отправлено/i),
  /** Candidate side. */
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /мои предложения/i }),
  accept: (p: Page): Locator => p.getByRole('button', { name: /^принять$/i }),
  reject: (p: Page): Locator => p.getByRole('button', { name: /^отклонить$/i }),
  joined: (p: Page): Locator => p.getByText(/вы вступили в команду/i),
  /** The 409 SEAT_TAKEN / TEAM_FULL texts of S3-11. */
  seatTaken: (p: Page): Locator =>
    p.getByRole('alert').filter({ hasText: /место (уже )?занято|кто-то успел/i }),
};

export const voteUi = {
  heading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /голосование за тимлида/i }),
  /** aria-live region that announces the phase (S3-13). */
  phase: (p: Page): Locator => p.getByRole('status', { name: /этап голосования/i }),
  phaseText: {
    nominating: /выдвижение/i,
    voting: /голосование идёт|подача голосов/i,
    confirming: /подтверждение/i,
    closed: /завершено/i,
  },
  deadline: (p: Page): Locator => p.getByText(/до окончания/i),
  nominateSelf: (p: Page): Locator => p.getByRole('button', { name: /выдвинуть себя/i }),
  consent: (p: Page): Locator => p.getByRole('button', { name: /согласен баллотироваться/i }),
  voteFor: (p: Page, displayName: string): Locator =>
    p.getByRole('button', { name: new RegExp(`голосовать за ${escapeRegExp(displayName)}`, 'i') }),
  voted: (p: Page): Locator => p.getByText(/ваш голос учтён/i),
  respondAccept: (p: Page): Locator => p.getByRole('button', { name: /принять роль тимлида/i }),
  newLead: (p: Page, displayName: string): Locator =>
    p.getByText(new RegExp(`тимлид:?\\s*${escapeRegExp(displayName)}`, 'i')),
};

export const bellUi = {
  button: (p: Page): Locator => p.getByRole('button', { name: /уведомления/i }),
  unreadBadge: (p: Page): Locator => p.getByRole('status', { name: /непрочитанных/i }),
  item: (p: Page, text: RegExp): Locator => p.getByRole('menuitem').filter({ hasText: text }),
};
