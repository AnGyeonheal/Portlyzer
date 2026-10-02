# Calculation policy — END_OF_DAY_V1

The independent engine is exported from `src/lib/finance/index.ts`. It has no
database, provider, server, React, or environment dependencies. Its public inputs
reuse `src/lib/domain.ts`; all output money, quantities, and ratios are decimal
strings. **`null` means unavailable or mathematically undefined, not zero.**
Percentages are ratios: `"0.1"` means 10%; drawdown `"-0.2"` means a 20% decline.

## Public API and arithmetic

- `analyzePortfolio({ transactions, assets, prices, fx, filters }): AnalysisResult`
- `validateLedger(transactions, assets, costMethod): DataIssue[]`
- `projectGoal({ initial, monthlyContribution, annualReturn, years }): GoalProjectionResult`
- `projectGoalDetails(input): GoalProjectionDetails`
- `calculateXirr(cashflows, options?): XirrResult`
- `convertCurrency(amount, from, to, date, fx): string | null`
- `historicalQuantities(transactions, assets, date, costMethod = "FIFO"): HistoricalQuantity[]`
- All public interfaces, including the shared domain types, are exported.

The conversion helper uses the identical direct/inverse, no-lookahead,
seven-calendar-day market resolver. It accepts signed amounts, returns null for
missing/expired rates or invalid input, and needs no rate for a genuine zero or
same-currency conversion. Full diagnostic provenance remains available through
portfolio analysis.

The quantity helper reuses the validated balance replay without a price or FX
series. It returns positive end-of-day account/asset quantities in deterministic
order, omitting closed holdings. Invalid history or a malformed snapshot date
throws exported `FinanceValidationError`, whose `issues` contains the relevant
errors; invalid history is never silently presented as no holdings. Only
history through the requested date is evaluated. For ex-date entitlement,
call with the preceding calendar date and explicitly apply ex-date splits;
the helper does not silently include ex-date purchases, sales, or transfers.
Database precision limits and a service rule prohibiting future transactions
belong to draft/service validation, not this wall-clock-independent engine.

Financial arithmetic uses a **private Decimal.js constructor, 50 significant
digits, round-half-even**. Neither inputs nor global Decimal configuration are
mutated. No currency rounding is performed inside the ledger. Presentation can
round to a currency's display precision, but must not feed rounded values back
into calculations. Decimal inputs accept finite decimal/scientific strings up to
128 characters and exponents ±100. Input floats are not accepted.

Non-compact money, unit-price and quantity labels use Decimal plus localized
BigInt integral parts, rather than converting exact decimal strings to unsafe
binary integers. Display aggregation also uses 50-digit precision. Charts and
explicit compact labels use approximate numbers for presentation only.

Dates are real ISO `YYYY-MM-DD` calendar dates and are evaluated in UTC. Replay
order is **date, sequence, then transaction ID**; sequence must be a nonnegative
safe integer, and transaction IDs must be unique. Caller array order never
selects the accounting outcome. The reporting period is inclusive and limited
to 100 years; an empty account selection means all accounts.

## Validation, starting balances, and cash accounting

Validation does not require market prices or FX observations. It rejects
transient negative cash, overselling or over-transferring stock, duplicate IDs,
unknown assets, native-currency mismatches, invalid/negative numeric fields,
invalid dates/sequences, incompatible transaction fields, invalid FX legs,
invalid corporate actions, and self-transfers.

Starting balances must be explicit ledger records: cash via `DEPOSIT`, followed
by actual acquisitions via `BUY`, or transfers from an explicitly funded source.
The engine never invents cash to cover a purchase and does not permit borrowing,
short sales, or implicit foreign-exchange conversion. A transaction's balance
changes are atomic. For analysis, any ledger error through the report's end date
fails closed: summary amounts are null and holdings/history are not presented
as if the invalid transaction were silently omitted. Future-dated ledger records
do not affect a historical report; `validateLedger` checks its entire input.

| Kind | Source cash / effect |
| --- | --- |
| BUY | Debit `quantity × price + fee + tax`; capitalize all acquisition charges |
| SELL | Credit `quantity × price − fee − tax`; deduct historical disposed costs |
| DEPOSIT | Credit `amount − fee − tax`; external principal is **gross amount** |
| WITHDRAWAL | Debit `amount + fee + tax`; external principal is **amount** |
| DIVIDEND | Gross `amount`; credit `amount − tax − fee` |
| INTEREST | Credit `amount − tax − fee` |
| FEE | Debit `amount + fee + tax`; fee total includes `amount + fee` |
| TAX | Debit `amount + fee + tax`; tax total includes `amount + tax` |
| FX | Debit `amount + fee + tax` in source currency; credit actual `toAmount` in distinct `toCurrency` |
| TRANSFER | Move cash or stock once from `accountId` to `toAccountId`; charge fees/taxes only to source cash |
| SPLIT | Multiply account/asset quantities by positive `ratio`; never change cost or cash |
| VALUATION | Set a CUSTOM asset's **per-unit** native price; no cash, quantity, cost, fee, or tax change |

Amounts and prices for trades are positive. If an optional trade `amount` is
provided, it must equal gross `quantity × price`, not net settlement.
Dividend/sale withholding and charges cannot exceed gross proceeds. Standalone
dividends can be received after a holding has been sold; they remain asset/account
income but are not assigned to a nonexistent current lot.

Reported `dividends` is cash received after withholding and transaction fees;
`grossDividends` is provided separately. `interest` is also net. Summary `fees`
and `taxes` are informational period totals of every charge, including charges
already capitalized or deducted elsewhere: **do not subtract them twice**.

## Historical costs, splits, and transfers

Two independent remaining cost ledgers are maintained:

1. Native acquisition cost, including buy fees/taxes.
2. Reporting-currency acquisition cost converted at **each acquisition date**.

FIFO removes the oldest original acquisition first, retaining that priority
after a transfer. Moving average is per account/asset. It depletes every open
acquisition cohort proportionally; each cohort preserves its original date,
metadata, and native/report-currency cost. Therefore native average cost and
reporting-currency average cost are independent, not today's FX conversion of
one another. Final allocation remainders go to the final affected cohort.
An independent transaction quantity book ensures a complete sale/transfer
closes every affected cohort exactly, even after recurring-decimal average
allocations and fractional splits; no negligible residual-cost position is
invented by intermediate rounding.

Sales convert net proceeds at the sale-date FX rate. Realized report-currency
gain is those proceeds minus disposed historical report-currency cost. Native
unrealized gain uses native market value minus native cost; report-currency
unrealized gain uses current report-currency market value minus historical
report-currency cost. Cash FX movements and actual FX execution spreads affect
NAV/PnL but are not mislabeled as security-sale realized gains.

Splits/reverse splits multiply all quantity-equivalent fields of currently open
cohorts (including their historical disposed quantity equivalents), preserving
remaining and original monetary costs. Adjusted quantity-equivalent fields are
not historical execution quantities. A split's input `quantity` must be absent,
null, or explicitly zero; only `ratio` changes units. No implicit cash-in-lieu
is invented.

A transfer is one record, not a paired deposit/withdrawal:

- Cash transfers preserve currency and principal. A different currency requires
  a separate `FX` record. Transfer fees/taxes are expenses, not moved principal.
- In-kind transfers preserve original acquisition dates, costs, and FIFO
  priority. Average-cost transfers move proportional cohorts.
- When both accounts are selected, transferred principal has **zero external
  flow** and no realized sale. When just one is selected, cash is an external
  principal flow and stock is an external flow at **transfer-date closing FMV**
  (with permitted quote carry). Missing FMV makes the flow null, never zero.
- A selected destination's cost basis remains historical acquisition cost;
  its performance entry flow is FMV. Consequently its historical unrealized
  gain need not equal its gain since entering the selected account.

## Prices, FX, and provenance

Only **RAW closes** are accepted. Adjusted prices are rejected to avoid
double-counting recorded splits or dividends. Prices must match the asset's
native currency. An explicit zero market/custom valuation is a real zero;
missing quotes are not. Trading and benchmark funding require positive prices.

Prices and FX are looked up on or before the requested calendar date. **No
future lookahead or interpolation is allowed.** Both may carry at most
**seven calendar days**, inclusive, with a warning on every carried valuation
date. At eight days they become unavailable. The result's `provenance` records
requested date, observed date, age, source, fetchedAt, raw value, carry/stale
flags, and whether the observation was usable. A stale provenance value is
evidence only, not a usable valuation.

FX uses the latest eligible direct or inverse pair; KRW/USD are the supported
domain currencies. Same-currency and actual zero balances require no FX quote.
Inverse conversion divides by the original quote rather than multiplying by
a rounded reciprocal, avoiding artificial residuals such as `14000/1400`
being reported as slightly less than `10`.
Historical costs, income, charges, and external flows use transaction-date FX;
opening and end-of-day NAV use that valuation date's FX. A missing acquisition
FX rate taints its cost and related gain, not a separately available current NAV.

For conflicting provider observations on a date, latest `fetchedAt` wins, then
source/value deterministically, and a warning is emitted. `fetchedAt` is data
revision provenance, not an economic effective date. A CUSTOM `VALUATION`
overrides provider prices beginning on its date; last date/sequence/ID wins.
It remains the override until replaced, but is subject to the same seven-day
carry rule. Thus stale manual valuations do not silently become provider values.

## Reporting windows, PnL, and daily returns

Replay begins with the full preceding ledger, **not at the filter start**.
Opening NAV is the close on the calendar day before `from`. Every day from
`from` through `to`, including weekends, is then replayed and valued at close.

- Period PnL = ending NAV − opening NAV − period external flows.
- `netContributions` = cumulative net external principal through that date,
  including activity before `from`.
- `periodNetContributions` is provided separately.
- `cumulativePnl` = ending NAV − cumulative net contributions.
- `history.profit` is PnL since the period opening, not lifetime PnL.
- `costBasis` covers remaining securities, not cash.
- Summary/position realized gains, dividends, fees, taxes, and interest cover
  the selected period. Ending unrealized gains retain historical open costs.

For that reason, do not mechanically add period realized gain to lifetime open
unrealized gain and call it period PnL. FX cash gains, income, transfer-boundary
FMV, and pre-period unrealized changes also matter.

The unweighted **simple return** denominator is opening NAV plus **gross
positive external contributions in the period**, not deposits net of
withdrawals. This is disclosed as `simpleReturnCapital`; a nonpositive or
unknown denominator gives null.

Time-weighted daily return assumes external flows occur at **end of day**:

```
r[d] = (NAV[d] − externalFlow[d]) / NAV[d−1] − 1
TWR  = product(1 + r[d]) − 1
```

Internal purchases, sales, FX, income, and charges are not external flows.
The unitized wealth index starts at 1; MDD is the most negative
`index / runningPeak − 1`, never a drawdown on raw cash-flow-inflated NAV.

Undefined-period rules are deliberate:

- A zero-capital day with `NAV − flow = 0` establishes or resets funding
  neutrally. Until any actual funded capital exists, TWR/MDD are null.
- Non-flow wealth changes against zero opening capital (for example first-day
  buy fees) cannot be attributed under end-of-day timing. TWR and MDD for a
  window containing that day are null with a warning. Simple PnL is still real.
  Choose a later reporting start to measure a subsequent valid interval.
- Missing opening/daily NAV, missing flows, or negative adjusted capital makes
  the entire compounded path and MDD unavailable. The engine does not splice
  across missing days. Local later `dailyReturn` may still be shown.
- A 100% loss is a valid `-1` return. Calendar days before/after funding remain
  part of the requested window.
- `twr` is cumulative; `twrAnnualized = (1+twr)^(365/calendarDays) − 1`,
  using the full opening-close to ending-close interval.

## Money-weighted return (MWR/XIRR)

Investor cash flows are negative opening NAV on the opening date, negatives of
period external flows on their dates, and positive terminal NAV on `to`.
Same-day entries are netted. XIRR uses **ACT/365**:
`sum(CF[i] / (1+r)^((date[i]−date[0])/365)) = 0`.

`mwr.value` and `mwr.annualized` are **annual effective rates**. `cumulative`
converts the root to the span between the first and last nonzero net investor
flows; `days` exposes that span. It need not equal TWR's calendar window when
the portfolio began empty or was fully liquidated before the end.

The solver scans log-growth space, including a finer grid near zero and
stationary-point brackets, then uses Decimal bisection. A compensated
floating-point scan locates derivative brackets only; all final NPV residuals,
roots, and published rates use Decimal. Exponential rescaling prevents overflow
in long-horizon/near-minus-100% cases. Default `log(1+r)` bounds are **[-32, 32]**
and are returned explicitly. This is a finite numerical search, not a claim
that all conceivable roots outside or arbitrarily close within the domain have
been proved absent.

Statuses:

- `CONVERGED`: one detected root in the disclosed search domain.
- `MULTIPLE_ROOTS`: publish roots for inspection, but no preferred return.
- `NO_SOLUTION`: no suitable differing-date investment/receipt pattern, or no
  root found in the search domain. Same-day-only activity cannot define XIRR.
- `NON_CONVERGENT`: a detected bracket exhausted its iteration budget; no
  unconverged value is published.
- `MISSING_DATA` / `INVALID_INPUT`: unavailable data or invalid inputs.

MWR can remain available when an intermediate market close is missing, provided
its opening/terminal NAV and every external cash flow are independently known.
TWR cannot, because every intermediate daily return is required.

## Benchmark and buy-lot comparisons

The benchmark is explicitly **PRICE**, not total return: no dividend
reinvestment, charges, or taxes are invented. Price return compares the same
opening date and end date as portfolio performance and includes reporting FX
at both endpoints. Known ledger splits adjust benchmark units once per
asset/date, not once per account; conflicting account split ratios make that
benchmark adjustment unknown. Unrecorded corporate actions are not inferred.

**Compare `benchmark.returnRate` with `benchmark.portfolioPriceReturn`, never
directly with the income-inclusive `summary.twr`.** The portfolio's separate
dividend-excluded path treats actual **net cash dividends after withholding and
dividend fees** as end-of-day external flows for comparison purposes only:

```
comparativeFlow[d] = actualExternalFlow[d] + netCashDividends[d]
r_price[d] = (NAV[d] − comparativeFlow[d]) / NAV[d−1] − 1
portfolioPriceReturn = product(1 + r_price[d]) − 1
```

`history.portfolioPriceTwr` exposes the cumulative comparison path. Dividends
are converted at their payment-date FX rate. Actual ledger cash, cumulative
deposits, `history.externalFlow`, total PnL, total TWR, MWR, and MDD are unchanged.
The price-basis path has the same no-gap, zero-capital, and negative-capital
undefined rules as total TWR. Retained dividend cash remains in actual NAV and
therefore in the following day's denominator; this measures actual portfolio
allocation rather than pretending distributed cash was withdrawn. Other
portfolio expenses, interest, and cash FX effects are not silently removed.

For example, a portfolio with opening NAV 100, flat stock worth 100, and a net
dividend of 10 closes at 110. Total TWR is 10%, while its dividend-excluded
PRICE-basis return is 0%, correctly comparable to a flat PRICE benchmark's 0%.
With gross dividend 13, withholding 2 and dividend fee 1, it is still the actual
net 10—not gross 13—that is removed from the comparative numerator.

The virtual benchmark starts by investing opening NAV at its opening close and
buys/sells units for **identical external flows** at each flow day's close.
Only true external deposits/withdrawals and account-boundary transfers fund
this virtual investment. The comparative dividend adjustment never purchases
additional benchmark units.
Its `cashflowValue` is final virtual NAV; `pnl` subtracts opening NAV and period
flows. A missing price at a nonzero funding/withdrawal date permanently taints
the virtual units for that run. A withdrawal exceeding virtual capital yields
`BENCHMARK_NEGATIVE_CAPITAL` and null virtual NAV/PnL: no borrowing is assumed.
Price return can still be known when virtual-flow performance is unavailable,
or vice versa when an initially empty portfolio lacks the opening price.
Virtual benchmark PnL remains a PRICE-only scenario, not a claim of
income-inclusive excess profit over the actual portfolio.

Trades expose original acquisition IDs/dates, open/partial/closed status,
remaining/sold/transferred quantities, calendar holding days, realized and
unrealized report-currency contribution, net attributed dividends, memo/tags,
and return on attributed historical acquisition cost.

Transfers create destination cohort segments, not zero-cost buys. Source
segments distinguish `closedReason: TRANSFERRED` from `SOLD`; only actual sales
realize gain. Moved acquisition cost is excluded from the source segment's
return denominator. Lifetime lot figures and `periodRealizedPnlBase` are both
available. Closed trades before `from` are omitted; existing open lots are not.
Net dividends are allocated by live quantity at payment time.

A lot's benchmark comparison uses its acquisition close to **each actual sale
date** for disposed cost and acquisition close to `to` for remaining cost,
weighted by historical reporting-currency cost. This avoids comparing already
sold units with subsequent benchmark price changes. Transferred-out cost is
excluded; receiving segments retain original acquisition dates and costs.
For the same dividend basis, compare a trade's `priceReturnRate` (realized plus
unrealized capital contribution divided by attributed acquisition cost) with
`benchmarkReturn`. Its existing `returnRate` additionally includes attributed
net dividends and remains a separate total-income figure.

## Goal projections and explicit limits

The frozen `projectGoal` contract is the **yearly point array**
`{ year, value, contributions }[]`, including year zero. It does not have a
`.yearly` property. Invalid inputs return an empty array, not fabricated
zero-valued projections.

`projectGoalDetails` is the separate rich-result API with `.monthly`, `.yearly`,
totals, monthly rate, and validation `.issues`. Detailed points additionally
include `month` and `profit`. Invalid details contain empty point arrays, null
totals and diagnostic issues.

Goal inputs are nonnegative initial/monthly amounts, integer years 0–100, and an
annual effective return ratio of at least -1. Monthly return is
`(1+annualReturn)^(1/12)−1`, **not annualReturn/12**. Contributions occur at month
end after growth. Detailed output includes month-zero, monthly/yearly points,
final value, total contributions, growth, monthly rate, and validation issues.
These are deterministic scenarios, not forecasts; no inflation, tax, fee,
currency conversion, volatility, or guarantee is implied.

The engine intentionally does not model shorts, leverage, derivatives,
withholding refunds, dividend entitlement record dates, tax-lot elections,
cash-in-lieu, provider-inferred corporate actions, intraday TWR, or persistent
FX cost lots for cash. Monetary portfolio PnL still includes actual cash FX
changes. These omissions are not replaced with guessed values.
