# Market data and manual observations

Portlyzer deliberately does **not** promise universal market coverage or real-time quotes. Missing data stays missing; provider failures never substitute demo data. Prices used for portfolio accounting are **raw daily closes**. Adjusted-only responses are rejected, so recorded splits and dividends are not double-counted.

## Provider and licensing matrix

| Source | Enabled coverage | Requirements / limits |
| --- | --- | --- |
| `FRANKFURTER` | ECB USD/KRW daily reference FX from 1999-01-04 | Keyless, business-day observations. An explicit ECB route avoids blending multiple providers. This is neither an executable FX quote nor a real-time rate. |
| `ALPHA_VANTAGE` | Optional raw daily closes for explicitly configured US USD STOCK/ETF assets on `NASDAQ`, `NYSE`, or `AMEX` | Both server-only `ALPHA_VANTAGE_API_KEY` and `ALPHA_VANTAGE_LICENSE_ACK=true` are required. Assets must have `country=US` and `provider=ALPHA_VANTAGE`; coverage is not guaranteed even for eligible symbols. |
| `MANUAL` | KR/US securities, crypto, custom assets and USD/KRW FX, supplied by the user | No remote request. User must have rights to the observations. Dates, decimal precision, native currency and asset ownership are validated. |
| `DEMO` | Clearly synthetic test/demo observations | A separate adapter requiring `user.isDemo`. Source is always `DEMO`. Normal refresh accepts only the two real provider IDs above. |

No Korean-stock automatic coverage is claimed. Korean securities, cryptocurrency and custom assets use manual observations by default. No Coinbase adapter or fictional broker API is implemented. Coinbase's external analytics/valuation restrictions are incompatible with enabling it here without additional permission.

### Frankfurter / ECB

- Endpoint: `GET https://api.frankfurter.dev/v2/providers/ecb/rates?base=USD&quotes=KRW&from=2024-01-02&to=2024-01-05`
- The v2 response is an **array** of `{date, base, quote, rate}` objects, not a v1 date-keyed map.
- Dates are observation dates, not fetch dates. Weekends/holidays are never inserted as synthetic observations. Carry-forward policy belongs to the finance engine and preserves the original observed date and provenance.
- Attribution: **European Central Bank (ECB), foreign exchange reference rates, retrieved via Frankfurter.** ECB reference data may be used commercially subject to the source's terms and accurate attribution. Frankfurter's software/API license does not remove upstream data obligations or imply ECB endorsement.
- No API key is required. No numerical official quota is promised: abuse limits can apply.
- Official references: [Frankfurter documentation](https://frankfurter.dev/), [license](https://frankfurter.dev/license/), [ECB provider information](https://frankfurter.dev/providers/ecb/), [ECB disclaimer and reuse conditions](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html).

### Alpha Vantage (opt-in)

- Endpoint function: `TIME_SERIES_DAILY`, `outputsize=compact`, `datatype=json`.
- The adapter reads `Time Series (Daily)` → date → `4. close`, checks the returned symbol and marks the price `RAW`.
- The free compact result covers at most the **latest 100 observations**. `outputsize=full` is premium and is never requested. If the requested start predates the returned series, the job fails explicitly; use manual historical data rather than silently accepting a partial history.
- The published free allowance is **25 requests/day per API key**, shared across all users. Every retry consumes budget. The application's shared DB limit cannot account for another deployment/application using the same key; dedicate a key or coordinate usage externally.
- Terms default to personal/noncommercial use absent written agreement. `ALPHA_VANTAGE_LICENSE_ACK=true` is an operator acknowledgement, **not** a license grant. Do not enable in a commercial/shared deployment without appropriate rights.
- `ALPHA_VANTAGE_API_KEY` must never be `NEXT_PUBLIC_*`, sent to the browser or logged. Errors intentionally omit upstream response bodies and URLs containing the key.
- Official references: [daily API](https://www.alphavantage.co/documentation/#daily), [support/FAQ](https://www.alphavantage.co/support/#support), [terms](https://www.alphavantage.co/terms_of_service/).

## Replaceable adapter contract

`src/lib/providers/types.ts` defines `MarketDataProvider`: capabilities plus `getPrices`, `getFx`, `getDividends` and `getCorporateActions`. Price and FX results use decimal **strings**, ISO dates, `source` and `fetchedAt`; prices require `adjustment: "RAW"`. Unsupported capabilities raise a typed `PROVIDER_UNSUPPORTED` error, not a successful empty array. None of the current remote adapters imports dividends or corporate actions. Manual dividend/split ledger paths remain separate.

`createMarketDataProvider` is the explicit adapter registry; unknown IDs fail. Adding a provider requires verified rights, coverage, response validation and server-side request budgets, not a fallback chain. The manual adapter has no automatic read capabilities; manual writes are the service functions below.

## Manual API

All operations are scoped to the authenticated user's ID; client-supplied ownership/source/adjustment fields are rejected.

```ts
upsertManualPrice(userId, {
  assetId, date: "2024-01-02", close: "161.50", currency: "USD"
});
importManualPrices(userId, {
  rows: [{ assetId, date: "2024-01-02", close: "161.50", currency: "USD" }]
});
// CSV rows can identify an owned asset without exposing internal IDs:
importManualPrices(userId, {
  rows: [{ symbol: "IBM", exchange: "NYSE", date: "2024-01-02", close: "161.50", currency: "USD" }]
});
upsertManualFx(userId, {
  date: "2024-01-02", base: "USD", quote: "KRW", rate: "1313.23"
});
importManualFx(userId, {
  rows: [{ date: "2024-01-02", base: "USD", quote: "KRW", rate: "1313.23" }]
});
```

- Dates must be actual `YYYY-MM-DD` dates, no later than today's **UTC** date.
- Decimal inputs are strings, no exponents/signs/commas/leading zeros. At most 18 integer and 12 fractional digits fit `Decimal(30,12)` without implicit rounding. A raw price may be zero; an FX rate must be positive.
- Native price currency must match the owned asset. FX requires distinct supported currencies.
- A price-import row requires either `assetId` or **both** `symbol` and `exchange`. Labels are trimmed and matched case-insensitively against owned assets, never against another user's assets and never by symbol alone. An asset ID plus both labels is permitted only when they agree. Missing, ambiguous or mismatched identifiers fail the entire import. For case-variant duplicate labels, use only the precise asset ID. Asset creation is never implied by importing prices.
- Imports contain 1–2,000 rows, without duplicate asset/date keys for prices or currency-pair/date keys for FX (including inverse pairs). The entire payload and all asset ownership/currencies are checked before any data is written. Parameterized batches are committed atomically.
- Price duplicates are checked again **after** identity resolution, so an ID row and a symbol/exchange row cannot silently overwrite the same asset/date within one upload. Individual and bulk manual paths use the same private ownership/currency validators, transactional writes and parameterized upsert helpers.
- A new manual FX entry removes only the opposite **manual** orientation on that same date, avoiding contradictory manual reciprocal quotes; it preserves the input orientation and all provider observations.
- `MANUAL` records use separate unique source keys and are never overwritten by refresh. Analysis/workspace selection must choose manual observations first for the same asset/date; FX selection must treat the unordered currency pair/date as one key so inverse manual entries also override downloaded FX.
- Successful writes increment `User.ledgerVersion` in the same transaction, invalidating analysis.

Historical CSV uploads map to these bounded JSON services; keep symbol and decimal columns as strings (for example Korean ticker `005930` must retain its leading zeros). Use these headers:

```csv
symbol,exchange,date,close,currency
IBM,NYSE,2024-01-02,161.50,USD
005930,KOSPI,2024-01-02,79600,KRW
```

```csv
date,base,quote,rate
2024-01-02,USD,KRW,1313.23
```

Submit price rows to `POST /api/prices/import` and FX rows to `POST /api/fx/import`, both as `{ "rows": [...] }`. These examples demonstrate input format only; upload verified observations for assets already owned in the workspace. Workspace analysis selects one observation per unordered USD/KRW pair and date with manual-source priority and a `fetchedAt` tie-breaker. It retains the original base/quote direction and rate; the engine performs inverse division without pre-rounding a reciprocal.

## Refresh jobs, errors and operational limits

```ts
refreshMarketData(userId, {
  provider: "FRANKFURTER", from: "2024-01-02", to: "2024-01-05"
});
refreshMarketData(userId, {
  provider: "ALPHA_VANTAGE", assetId,
  from: "2024-01-02", to: "2024-01-05"
});
```

Refresh accepts at most 366 inclusive calendar dates per request. Frankfurter refresh stores the canonical USD/KRW pair; the finance layer may invert it with provenance. Alpha Vantage refresh always selects exactly one owned, explicitly eligible asset.

- `ProviderJob` stores `RUNNING`, `SUCCEEDED` or `FAILED` state, user ownership, counts, dates and safe error details. The workspace's job list should display failures as well as successes.
- Requests are keyed by user, provider, range and asset configuration. Registration uses a short per-user row lock and a unique request key; network calls do not hold database locks.
- A successful identical request is reused for **12 hours after completion**, without a network request or ledger-version bump. Concurrent callers receive the existing `RUNNING` job, not fabricated success.
- Failed requests are coalesced for 30 seconds to avoid retry storms. Later retries and cache expiry retain previous jobs under archived unique keys.
- A `RUNNING` job older than two minutes is marked failed when the same request is retried. A fenced completion prevents the stale worker from saving late results.
- Provider failure raises `AppError` with a stable `code` and `details.jobId`, and retains a failed job. Existing prices/FX remain intact. Saving observations, completing the job and incrementing `ledgerVersion` is atomic.
- If the database itself becomes unavailable while recording failure, `PROVIDER_JOB_STATE_UNAVAILABLE` still reports the durable job ID; the existing job may remain `RUNNING` until stale-job recovery after database service resumes. Changing an asset's identity/configuration during refresh rejects the old result.
- Transport permits **three attempts total**, only for timeouts, network failures, HTTP 429/5xx or explicit rate-limit envelopes. Per-attempt timeout: 10 seconds, including body reading. Backoff starts at 250 ms; `Retry-After` seconds/date values are honored up to a five-second cap.
- Responses are limited to 2 MiB, including streamed bodies without `Content-Length`, and validated with Zod. Malformed, oversized, adjusted-only, mismatched or empty responses fail explicitly; no partial data is persisted.
- `ApiRateLimit` enforces deployment-wide and per-user budgets atomically. Alpha Vantage: **25/key and 10/user per anchored 24-hour window**. Frankfurter: **120/deployment and 30/user per anchored one-hour window**, conservative application policies, not official provider quotas. Rejected transactions cannot partially charge one budget. Counts reset atomically on the first request after a window expires.
- The database must be available to coordinate jobs and limits; no process-local fallback circumvents those protections.

## Explicit-user refresh CLI

Run from the project root (loads `.env` if present):

```powershell
npm run data:refresh -- --user-id USER_ID --provider FRANKFURTER --from 2024-01-02 --to 2024-01-05
npm run data:refresh -- --user-id USER_ID --provider ALPHA_VANTAGE --asset-id ASSET_ID --from 2024-01-02 --to 2024-01-05
```

Environment alternatives: `REFRESH_USER_ID`, `REFRESH_PROVIDER`, `REFRESH_FROM`, `REFRESH_TO`, `REFRESH_ASSET_ID`. An explicit user is mandatory; the script never iterates all users or guesses an account. Output is safe job JSON. Exit codes: `0` completed/cached success, `1` validation/provider/database failure, `2` the matching job is already running. Schedulers must supply their chosen user/range explicitly. Schedule according to daily-data semantics and licensing, not assumed real-time updates.

## Validation

```powershell
npx vitest run tests\unit\providers.test.ts tests\unit\providers-service.test.ts
$env:RUN_NETWORK_TESTS = "1"
npx vitest run tests\integration\market-network.test.ts
$env:RUN_INTEGRATION = "1"
npx vitest run tests\integration\market.test.ts
```

The keyless network test makes a real ECB request and checks the observed 2024-01-02 USD/KRW rate, `1313.23`. DB integration tests use opt-in `RUN_INTEGRATION=1`, mocked external responses and uniquely named owned users/keys; cleanup is restricted to records the tests create. Default tests do not require an API key or contact external providers.

On Node 24 hosts requiring an existing `HTTP_PROXY`/`HTTPS_PROXY`, start the test/server with `NODE_USE_ENV_PROXY=1`; if the organization's trusted CA is in the system store, `NODE_USE_SYSTEM_CA=1` enables that store. Do not disable TLS verification. The live smoke was verified through this environment's configured proxy.
