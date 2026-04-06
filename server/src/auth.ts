import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { bearer } from 'better-auth/plugins/bearer';
import { admin } from 'better-auth/plugins/admin';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import logger from './utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Auth = any;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

/**
 * Create a BetterAuth instance wired to our Drizzle/SQLite database.
 *
 * Plugins: organization, bearer, admin
 * Social providers: Google (when GOOGLE_CLIENT_ID is set)
 */
export function createAuth(drizzleDb: BetterSQLite3Database): Auth {
  // Build social providers dynamically based on env vars
  const socialProviders: Record<string, any> = {};

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
    logger.info('Google OAuth provider enabled');
  }

  const auth = betterAuth({
    database: drizzleAdapter(drizzleDb, { provider: 'sqlite' }),

    basePath: '/api/auth',

    emailAndPassword: {
      enabled: true,
    },

    socialProviders,

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },

    user: {
      additionalFields: {
        role: {
          type: 'string',
          defaultValue: 'user',
          input: false,
        },
      },
    },

    // Auto-promote admin email on signup/signin
    databaseHooks: {
      user: {
        create: {
          after: async (user: any) => {
            if (ADMIN_EMAIL && user.email === ADMIN_EMAIL) {
              // Promote to admin role
              await drizzleDb.run(
                { sql: `UPDATE users SET role = 'admin' WHERE id = ?`, params: [user.id] } as any,
              );
              logger.info({ email: user.email }, 'Auto-promoted user to admin');
            }
          },
        },
      },
    },

    plugins: [
      organization({
        allowUserToCreateOrganization: true,
      }),
      bearer(),
      admin(),
    ],

    trustedOrigins: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173', 'http://localhost:3000'],
  });

  return auth;
}
