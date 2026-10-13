import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceData } from "../../src/lib/contracts";

const stateDirectory = join(process.cwd(), ".e2e-state");
const query = "from=2025-01-02&to=2025-01-07&currency=USD";
const csv = [
  "date,kind,symbol,exchange,currency,quantity,price,amount,fee,tax,memo,sourceTransactionId",
  "2025-01-02,DEPOSIT,,,USD,,,5000,0,0,Opening deposit,e2e-deposit",
  "2025-01-03,BUY,AAPL,NASDAQ,USD,not-a-number,180,,1,0,First purchase,e2e-buy",
  "2025-01-06,DIVIDEND,AAPL,NASDAQ,USD,,,5,0,0.75,Received dividend,e2e-dividend",
  "2025-01-07,SELL,AAPL,NASDAQ,USD,3,200,,1,0,Partial sale,e2e-sell",
].join("\n");

async function navigate(page: Page, name: string) {
  await page.getByRole("navigation", { name: "주요 메뉴", exact: true }).getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1, exact: true })).toBeVisible();
}

async function selectPeriod(page: Page) {
  await page.getByLabel("조회 시작일", { exact: true }).fill("2025-01-02");
  await page.getByLabel("조회 종료일", { exact: true }).fill("2025-01-07");
  await page.getByLabel("표시 통화", { exact: true }).selectOption("USD");
}

async function workspace(request: APIRequestContext): Promise<WorkspaceData> {
  const response = await request.get(`/api/workspace?${query}`);
  expect(response.status()).toBe(200);
  return response.json();
}

test("signup, corrected import, analytics replay, isolation, export and persistent session", async ({ page, playwright, baseURL }) => {
  test.setTimeout(180000);
  const origin = baseURL ?? "http://127.0.0.1:3100";
  const email = `e2e-${randomUUID()}@example.invalid`;
  const password = `E2E-only-${randomUUID()}`;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/reset-password");
  await expect(page.getByText("이 환경에서는 이메일 복구가 설정되지 않았습니다. 관리자에게 문의해 주세요.", { exact: true })).toBeVisible();
  await page.goto("/login");
  await page.getByRole("button", { name: "회원가입", exact: true }).click();
  await page.getByLabel("이름", { exact: false }).fill("검증 투자자");
  await page.getByLabel("이메일", { exact: false }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "계정 만들기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();

  await navigate(page, "설정");
  await page.getByRole("button", { name: "계좌 추가", exact: true }).click();
  const accountDialog = page.getByRole("dialog", { name: "계좌 추가", exact: true });
  await accountDialog.getByLabel("계좌 이름", { exact: false }).fill("검증 계좌");
  await accountDialog.getByLabel("계좌 기본 통화", { exact: false }).selectOption("USD");
  await accountDialog.getByRole("button", { name: "계좌 저장하기", exact: true }).click();
  await expect(accountDialog).not.toBeVisible();
  await selectPeriod(page);

  await navigate(page, "거래 내역");
  await page.getByRole("button", { name: "파일 가져오기", exact: true }).click();
  await page.getByRole("button", { name: "일반 CSV·XLSX", exact: true }).click();
  await page.getByLabel("거래 파일", { exact: false }).setInputFiles({ name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "업로드하고 계속", exact: true }).click();
  await page.getByRole("button", { name: "거래 검증하기", exact: true }).click();
  await expect(page.getByLabel("3행 수량", { exact: true })).toBeVisible();
  await page.getByLabel("3행 수량", { exact: true }).fill("10");
  await page.getByRole("button", { name: "다시 검증", exact: true }).click();
  await page.getByRole("button", { name: "최종 미리보기", exact: true }).click();
  await page.getByRole("button", { name: "4건 가져오기 확정", exact: true }).click();
  await page.getByRole("button", { name: "거래 내역 확인하기", exact: true }).click();

  let data = await workspace(page.request);
  expect(data.transactions).toHaveLength(4);
  expect(data.analysis.summary.totalValue).toBeNull();
  const asset = data.assets.find((candidate) => candidate.symbol === "AAPL");
  expect(asset).toBeDefined();
  const prices = await page.request.post("/api/prices/import", {
    headers: { origin }, data: { rows: [
      { symbol: "AAPL", exchange: "NASDAQ", date: "2025-01-03", close: "180", currency: "USD" },
      { symbol: "AAPL", exchange: "NASDAQ", date: "2025-01-06", close: "200", currency: "USD" },
      { symbol: "AAPL", exchange: "NASDAQ", date: "2025-01-07", close: "210", currency: "USD" },
    ] },
  });
  expect(prices.ok()).toBeTruthy();
  await page.getByRole("button", { name: "워크스페이스 새로고침", exact: true }).click();
  await navigate(page, "대시보드");
  await expect(page.getByText(/5,272\.25/).first()).toBeVisible();
  data = await workspace(page.request);
  expect(data.analysis.summary.totalValue).toBe("5272.25");
  expect(data.analysis.summary.totalPnl).toBe("272.25");

  await navigate(page, "거래 내역");
  await page.getByRole("button", { name: "파일 가져오기", exact: true }).click();
  await page.getByRole("button", { name: "일반 CSV·XLSX", exact: true }).click();
  await page.getByLabel("거래 파일", { exact: false }).setInputFiles({ name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "업로드하고 계속", exact: true }).click();
  await expect(page.getByText("동일 파일 발견", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "거래 검증하기", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "가져오기 닫기", exact: true }).click();
  expect((await workspace(page.request)).transactions).toHaveLength(4);

  await page.getByRole("button", { name: "2025-01-03 매수 거래 수정", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "거래 수정", exact: true });
  await edit.getByLabel("체결 단가", { exact: false }).fill("181");
  await edit.getByRole("button", { name: "수정 저장", exact: true }).click();
  await expect(edit).not.toBeVisible();
  data = await workspace(page.request);
  expect(data.analysis.summary.totalValue).toBe("5262.25");
  const buy = data.transactions.find((transaction) => transaction.kind === "BUY");
  expect(buy?.revision).toBe(2);
  const audit = await page.request.get(`/api/transactions/${buy?.id}/history`);
  const auditText = await audit.text();
  expect(auditText).toContain("not-a-number");
  expect(auditText).toContain('"price":"180"');
  expect(auditText).toContain('"price":"181"');

  await page.getByRole("button", { name: "2025-01-06 거래 삭제", exact: true }).click();
  await page.getByRole("button", { name: "거래 삭제 확인", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "거래를 삭제할까요?", exact: true })).not.toBeVisible();
  data = await workspace(page.request);
  expect(data.analysis.summary.totalValue).toBe("5258");
  expect(data.analysis.summary.totalPnl).toBe("258");
  expect(data.dividends.actual).toHaveLength(0);
  expect(data.transactions).toHaveLength(3);

  await navigate(page, "대시보드");
  await page.getByLabel("조회 종료일", { exact: true }).fill("2025-01-20");
  await expect(page.getByText("데이터 확인이 필요해요", { exact: true })).toBeVisible();
  const staleResponse = await page.request.get("/api/workspace?from=2025-01-02&to=2025-01-20&currency=USD");
  const stale: WorkspaceData = await staleResponse.json();
  expect(stale.analysis.summary.totalValue).toBeNull();
  expect(stale.analysis.provenance.some((item) => item.kind === "PRICE" && item.observedOn === "2025-01-07" && !item.usable)).toBe(true);
  expect(stale.user.isDemo).toBe(false);
  await selectPeriod(page);

  for (const view of ["보유 자산", "수익률 분석", "자산 배분", "배당 관리", "매매 분석", "목표 관리", "설정"]) {
    await navigate(page, view);
  }
  const exported = await page.request.get("/api/export");
  expect(exported.ok()).toBeTruthy();
  const backup = await exported.json();
  expect(backup.transactions).toHaveLength(4);
  expect(backup.originals).toHaveLength(4);
  expect(backup.revisions.length).toBeGreaterThanOrEqual(6);
  expect(backup.user.email).toBe(email);
  expect(backup).not.toHaveProperty("sessions");
  expect(backup).not.toHaveProperty("authAccounts");
  expect(JSON.stringify(backup)).not.toContain('"password":');
  expect(JSON.stringify(backup)).not.toContain('"token":');

  const outsider = await playwright.request.newContext({ baseURL: origin });
  const signup = await outsider.post("/api/auth/sign-up/email", {
    headers: { origin }, data: { email: `isolation-${randomUUID()}@example.invalid`, password: `Isolated-${randomUUID()}`, name: "격리 검증" },
  });
  expect(signup.ok()).toBeTruthy();
  expect((await outsider.get(`/api/transactions/${buy?.id}/history`)).status()).toBe(404);
  expect((await outsider.get(`/api/workspace?${query}&accountId=${data.accounts[0].id}`)).status()).toBe(404);
  expect((await outsider.patch(`/api/accounts/${data.accounts[0].id}`, { headers: { origin }, data: { name: "Hijack", currency: "USD" } })).status()).toBe(404);
  expect((await workspace(outsider)).transactions).toHaveLength(0);
  await outsider.dispose();
  expect((await page.request.post("/api/accounts", { headers: { origin: "https://untrusted.invalid" }, data: { name: "CSRF", currency: "USD" } })).status()).toBe(403);
  expect((await page.request.post("/api/auth/sign-in/email", { headers: { origin }, data: { email, password: "a".repeat(20000) } })).status()).toBe(413);

  await page.reload();
  await selectPeriod(page);
  expect((await workspace(page.request)).analysis.summary.totalValue).toBe("5258");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그인하기", exact: true })).toBeVisible();
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  await page.getByLabel("이메일", { exact: false }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  expect((await workspace(page.request)).analysis.summary.totalValue).toBe("5258");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "전체 메뉴 열기", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "전체 메뉴 열기", exact: true }).click();
  await page.getByRole("navigation", { name: "모바일 전체 메뉴", exact: true }).getByRole("button", { name: "설정", exact: true }).click();
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(pageErrors).toEqual([]);

  mkdirSync(stateDirectory, { recursive: true });
  await page.context().storageState({ path: join(stateDirectory, "auth.json") });
  writeFileSync(join(stateDirectory, "expectation.json"), JSON.stringify({ userId: data.user.id, accountId: data.accounts[0].id, buyId: buy?.id, query, totalValue: "5258", transactionCount: 3 }));
});

test("isolated demo renders complete desktop and mobile analytics", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/login");
  await page.getByRole("button", { name: "가입 없이 데모 둘러보기", exact: false }).click();
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  await expect(page.getByText("DEMO · 가상 데이터", { exact: true })).toBeVisible();
  const response = await page.request.get("/api/workspace");
  const data: WorkspaceData = await response.json();
  expect(response.ok()).toBeTruthy();
  expect(data.user.isDemo).toBe(true);
  expect(data.assets.length).toBeGreaterThanOrEqual(4);
  expect(data.analysis.summary.totalValue).not.toBeNull();
  expect(data.analysis.issues.filter((issue) => issue.severity === "error").length).toBe(0);
  expect(data.analysis.benchmark?.returnRate).not.toBeNull();
  for (const name of ["보유 자산", "수익률 분석", "자산 배분", "배당 관리", "매매 분석", "목표 관리", "설정", "대시보드"]) await navigate(page, name);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
