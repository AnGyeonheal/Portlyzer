import nodemailer from "nodemailer";
import { AsyncLocalStorage } from "node:async_hooks";
import { runtimeConfig } from "./environment";
import { AppError } from "./errors";

const delivery = new AsyncLocalStorage<{ failure?: AppError }>();

export function requireMailDelivery<T>(action: () => Promise<T>): Promise<T> {
  // Better Auth logs and absorbs task rejections; retain delivery failures per HTTP request.
  return delivery.run({}, async () => {
    const result = await action();
    const failure = delivery.getStore()?.failure;
    if (failure) throw failure;
    return result;
  });
}

export async function sendAccountEmail(kind: "verification" | "reset", recipient: string, link: string) {
  const config = runtimeConfig();
  if (!config.mailEnabled) throw new AppError(503, "MAIL_DISABLED", "이 환경에서는 이메일 발송이 설정되지 않았습니다.");
  if (!URL.canParse(link) || new URL(link).origin !== config.authUrl) {
    throw new AppError(500, "MAIL_LINK_ORIGIN", "인증 링크 설정을 확인해 주세요.");
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    requireTLS: config.smtp.requireTLS,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    tls: { minVersion: "TLSv1.2" },
    disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    const action = kind === "verification" ? "이메일 인증" : "비밀번호 재설정";
    const result = await transport.sendMail({
      from: config.smtp.from, to: recipient, subject: `[Portlyzer] ${action}`,
      text: `Portlyzer ${action}\n\n아래 링크를 열어 ${action}을 완료하세요. 링크는 1시간 동안 유효합니다.\n\n${link}\n\n요청하지 않았다면 이 메일을 무시하세요. 비밀번호나 인증 링크를 다른 사람에게 전달하지 마세요.`,
    });
    if (!result.accepted.length || result.rejected.length) throw new Error("SMTP_REJECTED");
  } catch (error) {
    const incidentId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "mail_delivery_failed", incidentId, type: error instanceof Error ? error.name : "UnknownError" }));
    const failure = new AppError(503, "MAIL_DELIVERY_FAILED", "메일을 발송하지 못했습니다. 가입을 시도했다면 로그인에서 인증 메일을 다시 요청해 주세요.", { incidentId });
    const context = delivery.getStore();
    if (context) context.failure = failure;
    throw failure;
  } finally {
    transport.close();
  }
}
