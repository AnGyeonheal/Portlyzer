---
description: Preserve Portlyzer financial contracts and safe local validation
applyTo: "src/lib/**,prisma/**,tests/**,package.json"
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
