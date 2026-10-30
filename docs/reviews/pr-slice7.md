# feat: slice 7 — rewards, anti-fraud, admin review, complaints and peer reviews

## Summary

Slice 7 of `docs/plan.md` (S7-01..S7-11): the credit of a completed project and what follows from it.

- **Credit run** (`rewards`): `workspace.project_completed` opens a `credit_run` in `cooling` for 7 days, then the project is credited by role from the immutable `project_completion` snapshot (FR-REW-01..04). Counters, awards and series badges are applied once (CC-6), and the team bonus "Закрытая вакансия" is granted (FR-REW-10). Pending GitHub accounts are rechecked daily (FR-GH-09).
- **Anti-fraud** AF-01..25 in two phases (`completion`, `cooling_end`). A flag freezes the run and opens one fraud case (FR-REW-15).
- **Admin review** (FR-REW-16, AF-25): the queue, the case card and the final decision `ok`/`violation` behind a confirmation. `ok` returns the project to cooling (S7SEC-01). `violation` revokes the project and the awards built on it (M-4).
- **Complaints** (FR-REW-11): a member at the completion can dispute a project during cooling.
- **Peer reviews** (FR-PROF-08): reviews are published in batches of 2 or more authors after the window closes, with no author in the API, logs or order.
- **Web**: awards showcase, `/teams/[id]/credit`, the review form, and the admin fraud pages.
- **Platform**:
  - `TxRunner.afterCommit` queues work for after the commit. The cooling timer is added there (M-6), and the hourly `credit-due-sweep` repairs lost timers.
  - The afterCommit queue and the outbox kick flag are made per attempt outside the transaction's inherited CLS store. A `set` inside that store was lost, so before this fix no cooling timer was added and the relay kick never fired.

## Reviews

- `docs/reviews/slice7-code-review.md` and `docs/reviews/slice7-security-audit.md`: fixed C-1, H-1, H-2, M-1..M-6, M-8, S7SEC-01, 02, 03, 07, 08.
- `docs/reviews/slice7-second-review.md`: an independent second review of those fixes. One MEDIUM was fixed: the deletion step now locks open credit runs, which closes a race with the credit (152-FZ). Five LOW findings were fixed as well.
- The remaining items, with reasons, are in `docs/backlog.md` (section "Срез 7, ревью и аудит").

## Test plan

- [x] `tsc`, `eslint`, `depcruise`, `db:check`, `contract:check`
- [x] API integration: 3696/3696
- [x] Concurrency suite: 185/185, 5 runs plus 2 runs after the second review
- [x] Web vitest: 477/477
- [x] Playwright e2e slices 1-7 on the full `docker compose` stack
- [ ] CI on the PR

## Migrations

- `0019`..`0020`: rewards and profiles tables, and the partial index `peer_review_pending_team_idx`. Index `0020` is built without `CONCURRENTLY`. This is fine at the current size; it is recorded in the backlog.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
