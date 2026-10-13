---
description: Preserve Portlyzer financial contracts and safe local validation
applyTo: "src/lib/**,prisma/**,tests/**,scripts/**,next.config.ts,package.json"
---

## Financial contracts

- Treat [domain types](../../src/lib/domain.ts) and the [calculation policy](../../docs/CALCULATION_POLICY.md) as contracts. `projectGoal` returns a yearly array; `projectGoalDetails` returns the diagnostic object. Do not alias one as the other: the persisted-workspace tests verify the actual serialized shape.
- The independent engine interprets an empty account list as all accounts. The workspace API must pass an empty ledger for an explicitly selected portfolio with no accounts; never let its chart show the whole user's holdings while its transaction table is empty.
- Deduplicate same-day FX observations by unordered currency pair, with MANUAL precedence, but retain the original base, quote and rate. Dividing `3 / 0.00075` must produce exactly `4000`; pre-rounding the reciprocal creates false residuals.
- Preserve original transaction rows and all revisions. Revalidate the entire candidate ledger and commit current transactions, audit records, journal changes and ledger version atomically. Missing prices must not block otherwise valid ledger writes or become zero-valued assets.

## Verification

- Tests use an explicitly configured database only with `RUN_INTEGRATION=1`. Create unique fixture users and delete only those IDs; never reset the whole database. Live provider tests separately require `RUN_NETWORK_TESTS=1`.
- On Windows, active app/test processes can lock Prisma's native DLL. Generate the client after installation or explicit schema changes, not during every type check. Stop only known task-owned processes before regenerating; see [operations](../../docs/OPERATIONS.md).
- One Next development server may own a worktree's development lock even on another port. Coordinate ownership instead of starting competing servers or terminating processes by name. Verify persistence with a genuinely new server process and the restart E2E probe.

## Learnings

- Keep PostgreSQL's open log outside `PG_DATA` (for example `.local-db.log`). On Windows, crash recovery can otherwise hit a sharing violation while trying to synchronize its own log.
- Use `npm run build` including its standalone preparation, then `npm run start`; do not substitute `next start`. Verify that public/static assets are included and copied `.env*` files and local state are absent from the deployment output.
- Better Auth may log and absorb mail callback rejections. Preserve delivery failures with the request-local mail boundary and test both SMTP failure responses and concurrent request isolation, not only successful sends.
- On restricted Windows hosts, use `portlyzer.cmd` and the project-local Node runtime rather than changing PowerShell execution policy. Manage only the launcher's own child through its authenticated local control channel; never stop arbitrary processes by name or a stale PID.
- Generated XLSX templates must round-trip through the strict importer and share their headers/mapping/limits with the UI. Do not globally permit `formula1`: allow only the known literal validations and bound the aggregate expanded `sqref` cell count before ExcelJS loads it. Trim only trailing blank formatting rows, not interior rows, so audit row numbers remain accurate.
- In browser tests, wait for the initial workspace refresh control to become enabled before editing global date/account filters. Filling server-rendered inputs before hydration can lose the first change and leave an invalid period.
