import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { db } from "./db";
import { runtimeConfig } from "./environment";
import { sendAccountEmail } from "./mail";

const config = runtimeConfig();

export const auth = betterAuth({
  appName: "Portlyzer",
  database: prismaAdapter(db, { provider: "postgresql" }),
  baseURL: config.authUrl,
  secret: config.secret,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: true,
    requireEmailVerification: config.requireEmailVerification,
    revokeSessionsOnPasswordReset: true,
    ...(config.mailEnabled ? {
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => sendAccountEmail("reset", user.email, url),
    } : {}),
  },
  ...(config.mailEnabled ? {
    emailVerification: {
      sendOnSignUp: config.requireEmailVerification,
      sendOnSignIn: config.requireEmailVerification,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => sendAccountEmail("verification", user.email, url),
    },
  } : {}),
  user: { deleteUser: { enabled: true } },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: false },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 60,
    customRules: {
      "/sign-in/email": { window: 60, max: 8 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 5 },
      "/reset-password": { window: 60, max: 8 },
      "/send-verification-email": { window: 60, max: 5 },
      "/change-password": { window: 60, max: 5 },
      "/delete-user": { window: 60, max: 3 },
    },
  },
  advanced: {
    database: { generateId: () => crypto.randomUUID() },
    defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
  },
  logger: { level: "error" },
});
