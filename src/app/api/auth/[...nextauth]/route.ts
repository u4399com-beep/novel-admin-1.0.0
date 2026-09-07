import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth-options";

if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET === 'change-this-to-a-random-string-min-32-chars') {
  console.warn('[Auth] NEXTAUTH_SECRET is not properly configured. Authentication may not work correctly.');
}

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

// ─────────────────────────────────────────────────────────────
// JWT Revocation Limitation Notice
// ─────────────────────────────────────────────────────────────
// This system uses stateless JWTs for session management. Since
// JWTs cannot be revoked server-side without additional
// infrastructure, a password change will NOT immediately
// invalidate existing sessions. The old JWT remains valid until
// it expires (maxAge: 24h).
//
// For this single-user admin system, the risk is acceptable:
//   - Only one admin user exists
//   - Password changes are infrequent
//   - The 24h expiry limits the window of exposure
//
// For a production multi-user system, a JWT blacklist backed by
// Redis (or a database table) would be required. The pattern
// would be:
//   1. On password change, store the revoked JWT's jti (or a
//      timestamp) in Redis with a TTL matching the token maxAge.
//   2. In a proxy or session callback, check the blacklist
//      before accepting the token.
//   3. On login, compare a password-hash version stored in the
//      JWT against the current hash in the DB — mismatch means
//      the password was changed and the token should be rejected.
// ─────────────────────────────────────────────────────────────

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
