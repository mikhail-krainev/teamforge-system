// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { teamErrorText } from './errors';
import { TeamErrorAlert } from './TeamErrorAlert';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
afterEach(cleanup);

const conflict = (code: string) =>
  new ApiError({
    status: 409,
    body: {},
    problem: { status: 409, code: code as never, title: code, type: 'about:blank' },
  });

describe('team error messages', () => {
  it.each([
    ['SEAT_TAKEN', 'уже занято'],
    ['TEAM_FULL', 'нет свободных мест'],
    ['PROJECT_LIMIT', 'лимит проектов'],
    ['OFFER_LIMIT', 'ожидающих предложений'],
    ['GITHUB_REQUIRED', 'привяжите аккаунт GitHub'],
    ['VERSION_CONFLICT', 'изменил кто-то другой'],
  ])('%s has its own Russian text', (code, part) => {
    expect(teamErrorText(conflict(code))).toContain(part);
  });

  it('falls back to the generic text for an unknown code', () => {
    expect(teamErrorText(new Error('x'))).toBe('Что-то пошло не так. Повторите попытку позже.');
  });

  it('GITHUB_REQUIRED links to GitHub linking, announced as an alert', () => {
    render(<TeamErrorAlert error={conflict('GITHUB_REQUIRED')} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Привязать GitHub' }).getAttribute('href')).toBe(
      '/settings',
    );
  });

  it('VERSION_CONFLICT offers a refresh', () => {
    const refresh = vi.fn();
    render(<TeamErrorAlert error={conflict('VERSION_CONFLICT')} onRefresh={refresh} />);
    screen.getByRole('button', { name: 'Обновить данные' }).click();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
