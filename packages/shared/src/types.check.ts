import type { Body, ErrorCode, Ok, Schema } from './index.js';

// Compile-time smoke checks of the helper types (no runtime code).
export type _Checks = [Body<'createTeam'>, Ok<'getMe'>, Ok<'listRoles'>, Schema<'Me'>, ErrorCode];
