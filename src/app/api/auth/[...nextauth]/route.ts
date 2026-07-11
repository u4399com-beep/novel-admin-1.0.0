import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import type { NextAuthOptions } from "next-auth";
import crypto from "crypto";

// Extend NextAuth types to include custom user properties
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
    };
  }
  interface User {
    id: string;
    name: string;
    email: string;
  }
  interface JWT {
    id: string;
    name?: string;
  }
}

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

// ─────────────────────────────────────────────────────────────
// Login Brute-Force Protection (global backstop with high threshold)
// Per-IP protection is enforced by middleware on /api/auth/* paths
// using loginRateLimit() from api-auth.ts
// ─────────────────────────────────────────────────────────────

// Global backstop: very high threshold to prevent system-wide DoS
// Per-IP protection is the primary defense (enforced in middleware)
let _globalLoginCount = 0;
let _globalLoginResetAt = Date.now() + 60 * 1000;
let _globalLockoutUntil = 0;

function checkGlobalLoginBackstop(): { allowed: boolean; retryAfter: number } {
  const now = Date.now();

  if (now < _globalLockoutUntil) {
    return { allowed: false, retryAfter: Math.ceil((_globalLockoutUntil - now) / 1000) };
  }

  if (now > _globalLoginResetAt) {
    _globalLoginCount = 0;
    _globalLoginResetAt = now + 60 * 1000;
  }

  _globalLoginCount++;

  // Very high threshold (50/min) - per-IP is the real protection
  if (_globalLoginCount > 50) {
    _globalLockoutUntil = now + 5 * 60 * 1000;
    return { allowed: false, retryAfter: 300 };
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
        // Global backstop check
        const rl = checkGlobalLoginBackstop();
        if (!rl.allowed) {
          throw new Error(`系统登录已临时锁定，请${rl.retryAfter}秒后再试`);
        }

        const adminUser = process.env.ADMIN_USERNAME || "admin";
        const adminPass = process.env.ADMIN_PASSWORD;

        // Require password to be explicitly configured - no default fallback
        if (!adminPass) {
          console.error("[Auth] ADMIN_PASSWORD environment variable is not set! Login is disabled.");
          throw new Error("系统未配置登录密码，请联系管理员设置ADMIN_PASSWORD环境变量");
        }

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
  cookies: {
    sessionToken: {
      name: `${process.env.NODE_ENV === "production" ? "__Secure-" : ""}next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: process.env.NODE_ENV === "production",
        path: "/",
      },
    },
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