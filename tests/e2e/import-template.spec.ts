import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { IMPORT_TEMPLATE } from "../../src/lib/import-template";
import type { WorkspaceData } from "../../src/lib/contracts";

test("downloaded Excel template is the default and imports corrected rows without manual mapping", async ({ page, playwright, baseURL }) => {
  test.setTimeout(180000);
  const origin = baseURL ?? "http://127.0.0.1:3100";
  const anonymous = await playwright.request.newContext({ baseURL: origin });
  expect((await anonymous.get(IMPORT_TEMPLATE.url)).status()).toBe(401);
  await anonymous.dispose();
  expect((await page.request.post("/api/demo", { headers: { origin }, data: {} })).ok()).toBe(true);
  const account = await page.request.post("/api/accounts", { headers: { origin }, data: { name: "Excel template fixture", currency: "USD" } });
  expect(account.status()).toBe(201);
  const accountId: string = (await account.json()).id;
  expect((await page.request.patch("/api/settings", { headers: { origin }, data: { benchmarkAssetId: null, baseCurrency: "USD" } })).ok()).toBe(true);
  const query = `from=2025-01-02&to=2025-01-07&currency=USD&accountId=${accountId}`;
  const workspace = async (): Promise<WorkspaceData> => {
    const response = await page.request.get(`/api/workspace?${query}`);
    expect(response.status()).toBe(200);
    return response.json();
  };

  await page.goto("/");
  await expect(page.getByRole("button", { name: "워크스페이스 새로고침", exact: true })).toBeEnabled();
  await page.getByLabel("조회 시작일", { exact: true }).fill("2025-01-02");
  await page.getByLabel("조회 종료일", { exact: true }).fill("2025-01-07");
  await page.getByLabel("계좌 필터", { exact: true }).selectOption(accountId);
  await page.getByRole("navigation", { name: "주요 메뉴", exact: true }).getByRole("button", { name: "거래 내역", exact: true }).click();
  await page.getByRole("button", { name: "파일 가져오기", exact: true }).click();
  await expect(page.getByRole("button", { name: "표준 엑셀 양식", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("거래 파일", { exact: false })).toHaveAttribute("accept", ".xlsx");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "엑셀 양식 다운로드", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(IMPORT_TEMPLATE.filename);
  const path = await download.path();
  if (!path) throw new Error("Template download was not saved.");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(readFileSync(path)).buffer);
  expect(workbook.worksheets).toHaveLength(1);
  const sheet = workbook.worksheets[0];
  expect(sheet.getRow(2).hasValues).toBe(false);
  expect(sheet.getCell("D2").numFmt).toBe("@");
  sheet.getRow(2).values = ["2025-01-02", "입금", "USD", "", "", "", "", "5000"];
  sheet.getRow(3).values = ["2025-01-03", "매수", "USD", "AAPL", "NASDAQ", "invalid", "180", "", "1"];
  sheet.getRow(4).values = ["2025-01-06", "배당", "USD", "AAPL", "NASDAQ", "", "", "5", "", "0.75"];
  sheet.getRow(5).values = ["2025-01-07", "매도", "USD", "AAPL", "NASDAQ", "3", "200", "", "1"];

  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  sheet.getCell("A1").value = "다른 날짜 열";
  const wrongHeaders = Buffer.from(await workbook.xlsx.writeBuffer());
  await page.getByLabel("거래 파일", { exact: false }).setInputFiles({ name: "wrong.xlsx", mimeType: IMPORT_TEMPLATE.mimeType, buffer: wrongHeaders });
  await page.getByRole("button", { name: "엑셀 업로드·검증", exact: true }).click();
  await expect(page.getByText(/표준 엑셀 양식의 열 이름과 순서를 유지해 주세요/)).toBeVisible();
  expect((await workspace()).transactions).toHaveLength(0);

  await page.getByLabel("거래 파일", { exact: false }).setInputFiles({ name: "filled-template.xlsx", mimeType: IMPORT_TEMPLATE.mimeType, buffer: bytes });
  await page.getByRole("button", { name: "엑셀 업로드·검증", exact: true }).click();
  await expect(page.getByLabel("3행 수량", { exact: true })).toBeVisible();
  await expect(page.getByLabel("거래일 열 연결", { exact: true })).toHaveCount(0);
  expect((await workspace()).transactions).toHaveLength(0);
  await page.getByLabel("3행 수량", { exact: true }).fill("10");
  await page.getByRole("button", { name: "다시 검증", exact: true }).click();
  await page.getByRole("button", { name: "최종 미리보기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "4건의 거래를 반영할 준비가 됐어요", exact: true })).toBeVisible();
  expect((await workspace()).transactions).toHaveLength(0);
  await page.getByRole("button", { name: "4건 가져오기 확정", exact: true }).click();
  await page.getByRole("button", { name: "거래 내역 확인하기", exact: true }).click();
  const imported = await workspace();
  expect(imported.transactions).toHaveLength(4);
  const purchase = imported.transactions.find((row) => row.kind === "BUY");
  expect(purchase?.quantity).toBe("10");
  const history = await page.request.get(`/api/transactions/${purchase?.id}/history`);
  expect((await history.json()).original.rawData).toMatchObject({ "수량": "invalid" });

  expect((await page.request.post("/api/prices/import", { headers: { origin }, data: { rows: [
    { symbol: "AAPL", exchange: "NASDAQ", currency: "USD", date: "2025-01-03", close: "180" },
    { symbol: "AAPL", exchange: "NASDAQ", currency: "USD", date: "2025-01-06", close: "200" },
    { symbol: "AAPL", exchange: "NASDAQ", currency: "USD", date: "2025-01-07", close: "210" },
  ] } })).ok()).toBe(true);
  expect((await workspace()).analysis.summary.totalValue).toBe("5272.25");
  expect((await workspace()).analysis.summary.totalPnl).toBe("272.25");

  await page.getByRole("button", { name: "파일 가져오기", exact: true }).click();
  await page.getByLabel("거래 파일", { exact: false }).setInputFiles({ name: "filled-template.xlsx", mimeType: IMPORT_TEMPLATE.mimeType, buffer: bytes });
  await page.getByRole("button", { name: "엑셀 업로드·검증", exact: true }).click();
  await expect(page.getByText("동일 파일 발견", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "거래 검증하기", exact: true })).toBeDisabled();
  expect((await workspace()).transactions).toHaveLength(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
