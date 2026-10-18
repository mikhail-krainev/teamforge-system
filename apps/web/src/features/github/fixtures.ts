// Sample data for the GitHub connection tests (typed by the generated contract).
import type { AvailableRepository, RepositoryLink } from './api';

export const INSTALLATION_ID = 424242;

export function sampleAvailable(overrides: Partial<AvailableRepository> = {}): AvailableRepository {
  return {
    repositoryId: 1001,
    fullName: 'teamforge-demo/notes',
    private: false,
    fork: false,
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

export function sampleLink(overrides: Partial<RepositoryLink> = {}): RepositoryLink {
  return {
    repositoryId: 1001,
    fullName: 'teamforge-demo/notes',
    installationId: INSTALLATION_ID,
    status: 'active',
    private: false,
    linkedAt: '2026-02-01T10:00:00.000Z',
    linkedBy: '0192f0a0-7c1e-7b3a-8d2f-3a4b5c6d7e8f',
    warnings: [],
    ...overrides,
  };
}
