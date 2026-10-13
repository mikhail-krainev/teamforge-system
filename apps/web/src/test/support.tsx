import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Schema } from 'shared';
import { makeQueryClient } from '@/app/providers';

/** Absolute API origin for tests (Node's `Request` needs a full URL). */
export const API = 'http://localhost/api';

export type ResumeUpload = Schema<'ResumeUpload'>;

export const UPLOAD_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000a001';

export function sampleUpload(overrides: Partial<ResumeUpload> = {}): ResumeUpload {
  return {
    id: UPLOAD_ID,
    status: 'done',
    keepFile: false,
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Renders inside a `QueryClient` built like the real one (global error handling included). */
export function renderWithClient(ui: ReactElement, client: QueryClient = makeQueryClient()) {
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, ...view };
}
