import Decimal from "decimal.js";
import { z } from "zod";

export const currencySchema = z.enum(["KRW", "USD"]);
export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return value.slice(0, 4) !== "0000" && Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value;
}, "Use an actual YYYY-MM-DD calendar date.");
export const observationDateSchema = calendarDateSchema.refine(
  value => value <= new Date().toISOString().slice(0, 10),
  "Future observations are not allowed.",
);
export const decimalStringSchema = z.string().max(31).regex(
  /^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/,
  "Use a nonnegative decimal string with at most 18 integer and 12 fractional digits.",
);
export const positiveDecimalSchema = decimalStringSchema.refine(
  value => /^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/.test(value) && new Decimal(value).gt(0),
  "The rate must be greater than zero.",
);

export const dateRangeSchema = z.object({
  from: observationDateSchema,
  to: observationDateSchema,
}).strict().superRefine((value, ctx) => {
  if (value.from > value.to) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "The end date must not precede the start date." });
  }
  if (Date.parse(value.to) - Date.parse(value.from) > 365 * 86_400_000) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "Refresh at most 366 calendar days per request." });
  }
});

export const manualPriceSchema = z.object({
  assetId: z.string().min(1).max(128),
  date: observationDateSchema,
  close: decimalStringSchema,
  currency: currencySchema,
}).strict();

const assetLabelSchema = z.string().trim().min(1).max(128).transform(value => value.toUpperCase());
const manualPriceImportRowSchema = manualPriceSchema.partial({ assetId: true }).extend({
  symbol: assetLabelSchema.optional(),
  exchange: assetLabelSchema.optional(),
}).strict().superRefine((row, ctx) => {
  if (!row.assetId && (!row.symbol || !row.exchange)) {
    ctx.addIssue({ code: "custom", path: ["assetId"], message: "Provide an asset ID or both symbol and exchange." });
  }
  if ((row.symbol === undefined) !== (row.exchange === undefined)) {
    ctx.addIssue({ code: "custom", path: [row.symbol === undefined ? "symbol" : "exchange"], message: "Symbol and exchange must be supplied together." });
  }
});

export const manualPriceImportSchema = z.object({
  rows: z.array(manualPriceImportRowSchema).min(1).max(2000),
}).strict().superRefine(({ rows }, ctx) => {
  const keys = new Set<string>();
  rows.forEach((row, index) => {
    const key = JSON.stringify(row.assetId ? ["id", row.assetId, row.date] : ["label", row.symbol, row.exchange, row.date]);
    if (keys.has(key)) {
      ctx.addIssue({ code: "custom", path: ["rows", index], message: "Each asset/date may appear only once per import." });
    }
    keys.add(key);
  });
});

export const manualFxSchema = z.object({
  date: observationDateSchema,
  base: currencySchema,
  quote: currencySchema,
  rate: positiveDecimalSchema,
}).strict().refine(value => value.base !== value.quote, {
  path: ["quote"], message: "FX requires two different currencies.",
});

export const manualFxImportSchema = z.object({
  rows: z.array(manualFxSchema).min(1).max(2000),
}).strict().superRefine(({ rows }, ctx) => {
  const keys = new Set<string>();
  rows.forEach((row, index) => {
    const key = JSON.stringify([row.date, ...[row.base, row.quote].sort()]);
    if (keys.has(key)) {
      ctx.addIssue({ code: "custom", path: ["rows", index], message: "Each currency pair/date may appear only once, including inverse pairs." });
    }
    keys.add(key);
  });
});

export const refreshSchema = z.object({
  provider: z.enum(["FRANKFURTER", "ALPHA_VANTAGE"]),
  from: observationDateSchema,
  to: observationDateSchema,
  assetId: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  const range = dateRangeSchema.safeParse({ from: value.from, to: value.to });
  if (!range.success) {
    for (const issue of range.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  }
  if (value.provider === "ALPHA_VANTAGE" && !value.assetId) {
    ctx.addIssue({ code: "custom", path: ["assetId"], message: "Select one explicitly configured US asset." });
  }
  if (value.provider === "FRANKFURTER" && value.assetId !== undefined) {
    ctx.addIssue({ code: "custom", path: ["assetId"], message: "Frankfurter supplies FX, not asset prices." });
  }
});

export type ManualPrice = z.infer<typeof manualPriceSchema>;
export type ManualPriceImportRow = z.infer<typeof manualPriceImportRowSchema>;
export type ManualFx = z.infer<typeof manualFxSchema>;
export type RefreshRequest = z.infer<typeof refreshSchema>;
