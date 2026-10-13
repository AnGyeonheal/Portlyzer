import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { smtpFixture } from "../helpers/smtp";

let mail: Awaited<ReturnType<typeof smtpFixture>>;
test.beforeAll(async () => { mail = await smtpFixture(Number(process.env.E2E_SMTP_PORT ?? "3125")); });
test.afterAll(async () => { await mail.close(); });

function latestLink(email: string) {
  const message = mail.messages.filter((message) => message.recipients.includes(email)).at(-1);
  const link = message?.text.match(/https?:\/\/[^\s]+/)?.[0];
  expect(link).toBeTruthy();
  return link!;
}

test("verified signup, password recovery, session revocation, password change and owned deletion", async ({ page, playwright, baseURL }) => {
  test.setTimeout(180000);
  const origin = baseURL!;
  const email = `auth-${randomUUID()}@example.invalid`;
  const password = `Before-${randomUUID()}`;
  const resetPassword = `After-reset-${randomUUID()}`;
  const changedPassword = `After-change-${randomUUID()}`;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/reset-password?error=INVALID_TOKEN");
  await expect(page.getByText("사용할 수 없는 재설정 링크입니다. 로그인 화면에서 새 링크를 요청해 주세요.", { exact: true })).toBeVisible();
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "가입 없이 데모 둘러보기" })).toHaveCount(0);
  await page.getByRole("button", { name: "회원가입", exact: true }).click();
  await page.getByLabel("이름", { exact: false }).fill("메일 검증 투자자");
  await page.getByLabel("이메일", { exact: false }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "계정 만들기", exact: true }).click();
  await expect(page.getByText("메일함에서 이메일 인증을 완료한 뒤 로그인해 주세요.", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  await expect.poll(() => mail.messages.filter((message) => message.recipients.includes(email)).length).toBe(1);
  const verification = latestLink(email);
  expect(new URL(verification).origin).toBe(origin);
  await page.goto(verification);
  await expect(page.getByText("이메일 인증이 완료되었습니다. 로그인해 주세요.", { exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: false }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  const account = await page.request.post("/api/accounts", { headers: { origin }, data: { name: "Delete fixture", currency: "USD" } });
  expect(account.status()).toBe(201);
  const accountId = (await account.json()).id;
  expect((await page.request.post("/api/transactions", { headers: { origin }, data: {
    accountId, date: "2025-01-02", kind: "DEPOSIT", currency: "USD", amount: "1000",
  } })).status()).toBe(201);

  const otherSession = await playwright.request.newContext({ baseURL: origin });
  expect((await otherSession.post("/api/auth/sign-in/email", { headers: { origin }, data: { email, password } })).ok()).toBe(true);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("button", { name: "비밀번호를 잊으셨나요?", exact: true }).click();
  await page.getByLabel("이메일", { exact: false }).fill(email);
  await page.getByRole("button", { name: "재설정 메일 보내기", exact: true }).click();
  await expect(page.getByText(/등록된 이메일이라면 비밀번호 재설정 안내가 발송됩니다/)).toBeVisible();
  await expect.poll(() => mail.messages.filter((message) => message.recipients.includes(email)).length).toBe(2);
  const resetLink = latestLink(email);
  await page.goto(resetLink);
  const token = new URL(page.url()).searchParams.get("token");
  expect(token).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByLabel("새 비밀번호", { exact: true }).fill(resetPassword);
  await page.getByLabel("새 비밀번호 확인", { exact: true }).fill(resetPassword);
  await page.getByRole("button", { name: "비밀번호 재설정하기", exact: true }).click();
  await expect(page.getByText(/기존 로그인 세션은 모두 종료되었습니다/)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  expect((await otherSession.get("/api/workspace")).status()).toBe(401);
  expect((await page.request.post("/api/auth/reset-password", { headers: { origin }, data: { token, newPassword: password } })).ok()).toBe(false);
  expect((await page.request.post("/api/auth/sign-in/email", { headers: { origin }, data: { email, password } })).status()).toBe(401);
  await page.getByRole("link", { name: "로그인으로 돌아가기" }).click();
  await page.getByLabel("이메일", { exact: false }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(resetPassword);
  await page.getByRole("button", { name: "로그인하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  expect((await otherSession.post("/api/auth/sign-in/email", { headers: { origin }, data: { email, password: resetPassword } })).ok()).toBe(true);

  await page.getByRole("navigation", { name: "주요 메뉴", exact: true }).getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "계정·보안", exact: true }).click();
  await page.getByLabel("현재 비밀번호", { exact: true }).fill(resetPassword);
  await page.getByLabel("새 비밀번호", { exact: true }).fill(changedPassword);
  await page.getByLabel("새 비밀번호 확인", { exact: true }).fill(changedPassword);
  await page.getByRole("button", { name: "비밀번호 변경하기", exact: true }).click();
  await expect(page.getByText("비밀번호를 변경하고 다른 기기의 세션을 종료했습니다.", { exact: true })).toBeVisible();
  expect((await otherSession.get("/api/workspace")).status()).toBe(401);
  expect((await page.request.get("/api/workspace")).status()).toBe(200);
  const outsider = await playwright.request.newContext({ baseURL: origin });
  const outsiderEmail = `preserved-${randomUUID()}@example.invalid`;
  const outsiderPassword = `Preserved-${randomUUID()}`;
  expect((await outsider.post("/api/auth/sign-up/email", { headers: { origin }, data: {
    name: "Preserved fixture", email: outsiderEmail, password: outsiderPassword,
  } })).ok()).toBe(true);
  await outsider.get(latestLink(outsiderEmail));
  expect((await outsider.post("/api/auth/sign-in/email", { headers: { origin }, data: { email: outsiderEmail, password: outsiderPassword } })).ok()).toBe(true);
  const preservedAccount = await outsider.post("/api/accounts", { headers: { origin }, data: { name: "Preserved account", currency: "USD" } });
  expect(preservedAccount.status()).toBe(201);
  const preservedId = (await preservedAccount.json()).id;
  expect((await page.request.post("/api/auth/delete-user", { headers: { origin }, data: {} })).status()).toBe(422);
  await page.getByRole("button", { name: "계정 탈퇴 진행", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "계정을 영구 삭제할까요?", exact: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await dialog.getByLabel("탈퇴 확인 이메일", { exact: true }).fill(email);
  await dialog.getByLabel("현재 비밀번호", { exact: true }).fill("wrong-password-for-test");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "내 계정 영구 삭제", exact: true }).click();
  await expect(dialog.getByText("현재 비밀번호가 올바르지 않습니다.", { exact: true })).toBeVisible();
  await dialog.getByLabel("현재 비밀번호", { exact: true }).fill(changedPassword);
  await dialog.getByRole("button", { name: "내 계정 영구 삭제", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그인하기", exact: true })).toBeVisible();
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  const preserved = await outsider.get("/api/workspace");
  expect(preserved.status()).toBe(200);
  expect((await preserved.json()).accounts.some((account: { id: string }) => account.id === preservedId)).toBe(true);
  await outsider.dispose();
  await otherSession.dispose();
  expect(pageErrors).toEqual([]);
});

test("mail errors, unknown addresses and untrusted requests are handled explicitly", async ({ request, baseURL }) => {
  const origin = baseURL!;
  const email = `mail-failure-${randomUUID()}@example.invalid`;
  const password = `Mail-failure-${randomUUID()}`;
  const signup = await request.post("/api/auth/sign-up/email", { headers: { origin }, data: { name: "Mail failure fixture", email, password } });
  expect(signup.ok()).toBe(true);
  expect((await request.post("/api/auth/request-password-reset", { headers: { origin: "https://untrusted.invalid" }, data: { email, redirectTo: "/reset-password" } })).status()).toBe(403);
  const count = mail.messages.length;
  const unknown = await request.post("/api/auth/request-password-reset", {
    headers: { origin }, data: { email: `unknown-${randomUUID()}@example.invalid`, redirectTo: "/reset-password" },
  });
  expect(unknown.ok()).toBe(true);
  expect(mail.messages.length).toBe(count);
  mail.reject(true);
  try {
    const failure = await request.post("/api/auth/request-password-reset", { headers: { origin }, data: { email, redirectTo: "/reset-password" } });
    expect(failure.status()).toBe(503);
    expect(await failure.json()).toMatchObject({ error: { code: "MAIL_DELIVERY_FAILED" } });
    expect(mail.messages.length).toBe(count);
  } finally { mail.reject(false); }
  expect((await request.post("/api/demo", { headers: { origin }, data: {} })).status()).toBe(403);
});
