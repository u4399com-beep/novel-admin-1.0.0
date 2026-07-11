import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import type { NextAuthOptions } from "next-auth";
import crypto from "crypto";

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf); // dummy comparison
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ═══════════════════════════════════════════════════════════════════════════
// Login Brute-Force Protection (global, not per-IP, since authorize
// callback doesn't have access to request headers)
// ═══════════════════════════════════════════════════════════════════════════

const loginAttempts: { count: number; resetAt: number } = { count: 0, resetAt: 0 };
const MAX_LOGIN_ATTEMPTS = 10;    // max failed attempts per window
const LOGIN_WINDOW_MS = 60 * 1000; // 1 minute window
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // 5 minute lockout after exceeding
let lockoutUntil = 0;

function checkLoginRateLimit(): { allowed: boolean; retryAfter: number } {
  const now = Date.now();

  // Check if in lockout period
  if (now < lockoutUntil) {
    return { allowed: false, retryAfter: Math.ceil((lockoutUntil - now) / 1000) };
  }

  // Reset window if expired
  if (now > loginAttempts.resetAt) {
    loginAttempts.count = 0;
    loginAttempts.resetAt = now + LOGIN_WINDOW_MS;
  }

  loginAttempts.count++;

  // If too many attempts, trigger lockout
  if (loginAttempts.count > MAX_LOGIN_ATTEMPTS) {
    lockoutUntil = now + LOGIN_LOCKOUT_MS;
    return { allowed: false, retryAfter: Math.ceil(LOGIN_LOCKOUT_MS / 1000) };
  }

  return { allowed: true, retryAfter: 0 };
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "管理员登录",
      credentials: {
        username: { label: "用户名", type: "text" },
        password: { label: "密码", type: "password" },
      },
      async authorize(credentials) {
        // Rate limit check BEFORE verifying credentials
        const rl = checkLoginRateLimit();
        if (!rl.allowed) {
          throw new Error(`登录尝试过于频繁，请${rl.retryAfter}秒后再试`);
        }

        const adminUser = process.env.ADMIN_USERNAME || "admin";
        const adminPass = process.env.ADMIN_PASSWORD || "novel2024";

        if (
          credentials?.username &&
          credentials?.password &&
          timingSafeEqual(credentials.username, adminUser) &&
          timingSafeEqual(credentials.password, adminPass)
        ) {
          return {
            id: "admin-1",
            name: "系统管理员",
            email: "admin@novel-system.local",
          };
        }
        return null;
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 24 * 60 * 60, // 24 hours
  },
  pages: {
    signIn: "/login",
  },
  secret: process.env.NEXTAUTH_SECRET,
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.name = token.name as string;
      }
      return session;
    },
  },
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };