// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLES, STACK_TAGS, sampleProfile } from '@/mocks/slice2/db';
import { API, renderWithClient } from '@/test/support';
import { ProfilePage } from './ProfilePage';
import type { Profile } from './model';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
// The resume section is tested on its own; here a button stands for "the resume changed the profile".
let resumeChanged: (profile: Profile) => void = () => undefined;
vi.mock('./resume/ResumeSection', () => ({
  ResumeSection: ({ onProfileChanged }: { onProfileChanged: (profile: Profile) => void }) => {
    resumeChanged = onProfileChanged;
    return null;
  },
}));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function serve(profile: Profile | null) {
  server.use(
    http.get(`${API}/v1/me/profile`, () =>
      profile ? HttpResponse.json(profile) : new HttpResponse(null, { status: 404 }),
    ),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLES, nextCursor: null }),
    ),
    http.get(`${API}/v1/catalog/stack-tags`, () =>
      HttpResponse.json({ items: STACK_TAGS, nextCursor: null }),
    ),
  );
}
const nameInput = () => screen.getByLabelText('Имя') as HTMLInputElement;
const type = (value: string) => fireEvent.change(nameInput(), { target: { value } });
const changeFromResume = (name: string) =>
  resumeChanged(sampleProfile({ version: 2, displayName: name }));

describe('S2CR-09: ProfilePage keeps unsaved edits', () => {
  it('a profile changed by the resume replaces a clean form', async () => {
    serve(sampleProfile());
    renderWithClient(<ProfilePage />);
    await waitFor(() => expect(nameInput().value).toBe('Анна Смирнова'));
    changeFromResume('Из резюме');
    await waitFor(() => expect(nameInput().value).toBe('Из резюме'));
    expect(screen.queryByText(/несохранённые правки/)).toBeNull();
  });

  it('a form with edits is not replaced: the edit survives and the user is told', async () => {
    serve(sampleProfile());
    renderWithClient(<ProfilePage />);
    await waitFor(() => expect(nameInput().value).toBe('Анна Смирнова'));
    type('Моя правка');
    changeFromResume('Из резюме');
    expect(await screen.findByText(/несохранённые правки/)).toBeTruthy();
    expect(nameInput().value).toBe('Моя правка');
  });

  it('the user may load the fresh data on purpose', async () => {
    serve(sampleProfile());
    renderWithClient(<ProfilePage />);
    await waitFor(() => expect(nameInput().value).toBe('Анна Смирнова'));
    type('Моя правка');
    changeFromResume('Из резюме');
    fireEvent.click(await screen.findByRole('button', { name: /Загрузить актуальные данные/ }));
    await waitFor(() => expect(nameInput().value).toBe('Из резюме'));
    expect(screen.queryByText(/несохранённые правки/)).toBeNull();
  });

  it('saving the edits removes the notice', async () => {
    serve(sampleProfile());
    server.use(
      http.put(`${API}/v1/me/profile`, () =>
        HttpResponse.json(sampleProfile({ version: 3, displayName: 'Моя правка' })),
      ),
    );
    renderWithClient(<ProfilePage />);
    await waitFor(() => expect(nameInput().value).toBe('Анна Смирнова'));
    type('Моя правка');
    changeFromResume('Из резюме');
    await screen.findByText(/несохранённые правки/);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }));
    await waitFor(() => expect(screen.queryByText(/несохранённые правки/)).toBeNull());
    expect(nameInput().value).toBe('Моя правка');
  });
});
