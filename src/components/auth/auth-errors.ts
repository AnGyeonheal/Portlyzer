const messages: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "이메일 또는 비밀번호가 올바르지 않습니다.",
  INVALID_PASSWORD: "현재 비밀번호가 올바르지 않습니다.",
  USER_ALREADY_EXISTS: "이미 가입된 이메일입니다. 로그인해 주세요.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "이미 가입된 이메일입니다. 로그인해 주세요.",
  PASSWORD_TOO_SHORT: "비밀번호는 12자 이상으로 입력해 주세요.",
  PASSWORD_TOO_LONG: "비밀번호는 128자 이하로 입력해 주세요.",
  TOO_MANY_REQUESTS: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  EMAIL_NOT_VERIFIED: "이메일 인증이 필요합니다. 받은 메일의 인증 링크를 확인해 주세요.",
  INVALID_TOKEN: "유효하지 않거나 만료된 링크입니다. 새 링크를 요청해 주세요.",
  TOKEN_EXPIRED: "만료된 링크입니다. 새 링크를 요청해 주세요.",
  SESSION_EXPIRED: "세션이 만료되었습니다. 다시 로그인해 주세요.",
  FRESH_SESSION_REQUIRED: "안전을 위해 다시 로그인한 뒤 시도해 주세요.",
  MAIL_DELIVERY_FAILED: "메일을 발송하지 못했습니다. 잠시 후 다시 시도하세요. 가입을 시도했다면 로그인에서 인증 메일을 다시 요청할 수 있습니다.",
};

export function assertAuthResult(result: { error?: { code?: string; status?: number; error?: { code?: string } } | null }) {
  if (result.error) {
    throw new Error(messages[result.error.code ?? result.error.error?.code ?? ""] ??
      (result.error.status === 429 ? messages.TOO_MANY_REQUESTS : "인증 요청을 완료하지 못했습니다. 입력 정보를 확인하고 다시 시도해 주세요."));
  }
}
