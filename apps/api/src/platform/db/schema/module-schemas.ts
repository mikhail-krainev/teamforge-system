import { pgSchema } from 'drizzle-orm/pg-core';

/** One PostgreSQL schema per module (ADR-0001/0002). Tables are added by each module's schema task. */
export const authSchema = pgSchema('auth');
export const profilesSchema = pgSchema('profiles');
export const playbooksSchema = pgSchema('playbooks');
export const teamsSchema = pgSchema('teams');
export const matchingSchema = pgSchema('matching');
export const workspaceSchema = pgSchema('workspace');
export const githubSchema = pgSchema('github');
export const rewardsSchema = pgSchema('rewards');
