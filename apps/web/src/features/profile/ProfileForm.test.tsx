// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeQueryClient } from '@/app/providers';
import { ROLES, STACK_TAGS, sampleProfile } from '@/mocks/slice2/db';
import { problem } from '@/mocks/slice2/handlers';
import { toDraft, type Profile } from './model';
import { ProfileForm } from './ProfileForm';

// Node's Request needs an absolute URL, so the singleton client gets one here.
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const PUT_URL = 'http://localhost/api/v1/me/profile';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function renderForm(profile: Profile, onAdopt = vi.fn()) {
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <ProfileForm
        initial={toDraft(profile)}
        version={profile.version}
        roles={ROLES}
        tags={STACK_TAGS}
        onAdoptCurrent={onAdopt}
      />
    </QueryClientProvider>,
  );
  return onAdopt;
}

const rename = (name: string) =>
  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: name } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }));

describe('ProfileForm', () => {
  it('sends the stored version and shows the saved status', async () => {
    const bodies: Array<{ version: number; displayName: string }> = [];
    server.use(
      http.put(PUT_URL, async ({ request }) => {
        bodies.push((await request.json()) as (typeof bodies)[number]);
        return HttpResponse.json(sampleProfile({ version: 2, displayName: 'Мария' }));
      }),
    );
    renderForm(sampleProfile());
    rename('Мария');
    save();
    expect(await screen.findByText('Профиль сохранён.')).toBeTruthy();
    expect(bodies).toEqual([expect.objectContaining({ version: 1, displayName: 'Мария' })]);
  });

  it('blocks an invalid form and ties the message to the field', async () => {
    let calls = 0;
    server.use(http.put(PUT_URL, () => (calls++, HttpResponse.json(sampleProfile()))));
    renderForm(sampleProfile());
    rename('И');
    save();
    const input = screen.getByLabelText('Имя');
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    const message = describedBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(message).toContain('от 2 до 60 символов');
    expect(calls).toBe(0);
  });

  it('on 409 shows the current data and overwrites with the current version', async () => {
    const current = sampleProfile({ version: 5, displayName: 'Чужое имя' });
    const versions: number[] = [];
    server.use(
      http.put(PUT_URL, async ({ request }) => {
        const body = (await request.json()) as { version: number };
        versions.push(body.version);
        if (body.version !== 5) return problem(409, 'VERSION_CONFLICT', { current });
        return HttpResponse.json(sampleProfile({ version: 6, displayName: 'Мария' }));
      }),
    );
    renderForm(sampleProfile());
    rename('Мария');
    save();
    expect(await screen.findByText('Профиль уже изменили')).toBeTruthy();
    expect(screen.getByText('Имя: Чужое имя')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Перезаписать моими данными' }));
    expect(await screen.findByText('Профиль сохранён.')).toBeTruthy();
    expect(versions).toEqual([1, 5]);
    expect(screen.queryByText('Профиль уже изменили')).toBeNull();
  });

  it('on 409 can adopt the current data instead', async () => {
    const current = sampleProfile({ version: 3, displayName: 'Другое имя' });
    server.use(http.put(PUT_URL, () => problem(409, 'VERSION_CONFLICT', { current })));
    const onAdopt = renderForm(sampleProfile());
    save();
    fireEvent.click(await screen.findByRole('button', { name: 'Взять актуальные данные' }));
    expect(onAdopt).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
  });

  it('shows the Retry-After wait on 429', async () => {
    server.use(http.put(PUT_URL, () => problem(429, 'RATE_LIMITED', {}, { 'Retry-After': '30' })));
    renderForm(sampleProfile());
    save();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('30 секунд');
  });

  it('a double click on save sends one request', async () => {
    let calls = 0;
    server.use(
      http.put(PUT_URL, () => {
        calls += 1;
        return HttpResponse.json(sampleProfile({ version: 2 }));
      }),
    );
    renderForm(sampleProfile());
    rename('Мария');
    const button = screen.getByRole('button', { name: 'Сохранить профиль' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByText('Профиль сохранён.')).toBeTruthy();
    expect(calls).toBe(1);
  });

  it('S2CR-09: reports unsaved edits to the page and clears the report after a save', async () => {
    server.use(http.put(PUT_URL, () => HttpResponse.json(sampleProfile({ version: 2 }))));
    const dirty = vi.fn();
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <ProfileForm
          initial={toDraft(sampleProfile())}
          version={1}
          roles={ROLES}
          tags={STACK_TAGS}
          onAdoptCurrent={vi.fn()}
          onDirtyChange={dirty}
        />
      </QueryClientProvider>,
    );
    expect(dirty).toHaveBeenLastCalledWith(false);
    rename('Мария');
    expect(dirty).toHaveBeenLastCalledWith(true);
    save();
    await screen.findByText('Профиль сохранён.');
    expect(dirty).toHaveBeenLastCalledWith(false);
  });
});
