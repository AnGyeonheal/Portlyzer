import { z } from "zod";

type Environment = Record<string, string | undefined>;
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function runtimeConfig(env: Environment = process.env) {
  const errors: string[] = [];
  function flag(name: string, fallback = false) {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    if (value !== "true" && value !== "false") errors.push(`${name}: use true or false`);
    return value === "true";
  }
  function url(name: string) {
    const value = env[name] ?? "";
    if (!URL.canParse(value)) {
      errors.push(`${name}: a valid URL is required`);
      return null;
    }
    return new URL(value);
  }
  const mode = env.APP_MODE ?? "local";
  if (!["local", "public"].includes(mode)) errors.push("APP_MODE: use local or public");
  const authUrl = url("BETTER_AUTH_URL");
  const databaseUrl = url("DATABASE_URL");
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32 || /replace-with|placeholder|local-development-only/i.test(secret)) {
    errors.push("BETTER_AUTH_SECRET: use a unique random secret of at least 32 characters");
  }
  if (authUrl && (!["http:", "https:"].includes(authUrl.protocol) || authUrl.username || authUrl.password ||
    authUrl.pathname !== "/" || authUrl.search || authUrl.hash)) {
    errors.push("BETTER_AUTH_URL: use an HTTP(S) origin without credentials, a path or query");
  }
  if (authUrl && mode === "local" && !loopback.has(authUrl.hostname)) {
    errors.push("BETTER_AUTH_URL: local mode only permits a loopback origin");
  }
  if (authUrl && mode === "public" && (authUrl.protocol !== "https:" || loopback.has(authUrl.hostname))) {
    errors.push("BETTER_AUTH_URL: public mode requires a non-loopback HTTPS origin");
  }
  if (databaseUrl && (!["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !databaseUrl.username || !databaseUrl.password || databaseUrl.pathname.length < 2)) {
    errors.push("DATABASE_URL: use an authenticated PostgreSQL database");
  }
  if (databaseUrl && mode === "public" && !["require", "verify-ca", "verify-full"].includes(databaseUrl.searchParams.get("sslmode") ?? "")) {
    errors.push("DATABASE_URL: public mode requires PostgreSQL TLS (prefer sslmode=verify-full)");
  }
  const demoEnabled = flag("ENABLE_DEMO");
  const mailEnabled = flag("MAIL_ENABLED");
  const requireEmailVerification = flag("AUTH_REQUIRE_EMAIL_VERIFICATION", mode === "public");
  if (requireEmailVerification && !mailEnabled) errors.push("MAIL_ENABLED: verification requires a working mail transport");
  if (requireEmailVerification && demoEnabled) errors.push("ENABLE_DEMO: disable demo when email verification is required");
  if (mode === "public" && (!mailEnabled || !requireEmailVerification)) {
    errors.push("Public mode requires mail and email verification");
  }
  const smtpSecure = flag("SMTP_SECURE");
  const smtpPort = Number(env.SMTP_PORT ?? (smtpSecure ? "465" : "587"));
  const smtpHost = env.SMTP_HOST ?? "";
  const smtpUser = env.SMTP_USER || undefined;
  const smtpPassword = env.SMTP_PASSWORD || undefined;
  const mailFrom = env.MAIL_FROM ?? "";
  if (mailEnabled) {
    if (!smtpHost || /[\s/@\\]/.test(smtpHost)) errors.push("SMTP_HOST: use a hostname, not a URL");
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) errors.push("SMTP_PORT: use a port from 1 to 65535");
    if (!z.email().safeParse(mailFrom).success) errors.push("MAIL_FROM: a sender email address is required");
    if (!!smtpUser !== !!smtpPassword) errors.push("SMTP_USER and SMTP_PASSWORD: configure both or neither");
    if (mode === "public" && (!smtpUser || !smtpPassword || loopback.has(smtpHost))) {
      errors.push("SMTP: public mode requires an authenticated remote transport");
    }
  }
  if (flag("ALPHA_VANTAGE_LICENSE_ACK") && !env.ALPHA_VANTAGE_API_KEY) {
    errors.push("ALPHA_VANTAGE_API_KEY: configure a key when enabling the licensed provider");
  }
  if (errors.length) throw new Error(`Invalid runtime configuration:\n${errors.join("\n")}`);
  return {
    mode, authUrl: authUrl!.origin, secret, demoEnabled, mailEnabled, requireEmailVerification,
    smtp: {
      host: smtpHost, port: smtpPort, secure: smtpSecure, user: smtpUser, password: smtpPassword,
      requireTLS: mode === "public" || !loopback.has(smtpHost), from: mailFrom,
    },
  };
}
