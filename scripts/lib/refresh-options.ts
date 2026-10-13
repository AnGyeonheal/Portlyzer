import { parseArgs } from "node:util";
import { AppError } from "../../src/lib/errors";
import { shiftDay } from "../../src/lib/input";

export function refreshOptions(args: string[], env: Record<string, string | undefined> = process.env, now = new Date()) {
  const { values } = parseArgs({
    args, options: {
      "user-id": { type: "string" }, provider: { type: "string" },
      from: { type: "string" }, to: { type: "string" }, "asset-id": { type: "string" },
      days: { type: "string" },
    }, strict: true, allowPositionals: false,
  });
  const userId = values["user-id"] ?? env.REFRESH_USER_ID;
  if (!userId?.trim()) throw new AppError(422, "CLI_USER_REQUIRED", "An explicit --user-id or REFRESH_USER_ID is required; bulk refresh is never implied.");
  let from = values.from ?? env.REFRESH_FROM;
  let to = values.to ?? env.REFRESH_TO;
  const days = values.days ?? env.REFRESH_DAYS;
  if (days !== undefined) {
    if (from || to || !/^[1-9]\d{0,2}$/.test(days) || Number(days) > 365) {
      throw new AppError(422, "CLI_DATE_RANGE", "Use either --days (1-365 inclusive UTC days) or explicit --from and --to, not both.");
    }
    to = now.toISOString().slice(0, 10);
    from = shiftDay(to, 1 - Number(days));
  }
  if (!from || !to) throw new AppError(422, "CLI_DATE_RANGE", "Set --from and --to, or --days for a rolling scheduled refresh.");
  const assetId = values["asset-id"] ?? env.REFRESH_ASSET_ID;
  return { userId, request: {
    provider: values.provider ?? env.REFRESH_PROVIDER ?? "FRANKFURTER",
    from, to, ...(assetId ? { assetId } : {}),
  } };
}
