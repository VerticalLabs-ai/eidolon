import { betterAuth } from 'better-auth';
import type {
  Auth as BetterAuthInstance,
  BetterAuthOptions,
  Session as BetterAuthSession,
  User as BetterAuthUser,
} from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { bearer } from 'better-auth/plugins/bearer';
import { admin } from 'better-auth/plugins/admin';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { users } from '@eidolon/db';
import logger from './utils/logger.js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

type AuthOptions = BetterAuthOptions & {
  session: {
    expiresIn: number;
    updateAge: number;
    cookieCache: {
      enabled: true;
      maxAge: number;
    };
  };
  user: {
    additionalFields: {
      role: {
        type: 'string';
        defaultValue: 'user';
        input: false;
      };
    };
  };
  plugins: [ReturnType<typeof organization>, ReturnType<typeof bearer>, ReturnType<typeof admin>];
};

type AuthOrganizationMember = {
  id: string;
  organizationId: string;
  role: string;
  userId: string;
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
};

type BaseAuth = BetterAuthInstance<AuthOptions>;
type AuthApi = BaseAuth['api'] & {
  listMembers: (input: {
    headers: Headers;
    query: {
      organizationId: string;
      limit?: number;
      filterField?: string;
      filterOperator?:
        | 'eq'
        | 'ne'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte'
        | 'in'
        | 'not_in'
        | 'contains'
        | 'starts_with'
        | 'ends_with';
      filterValue?: string | number | boolean | string[] | number[];
    };
  }) => Promise<{
    members: AuthOrganizationMember[];
    total: number;
  }>;
};

function buildAuthOptions(drizzleDb: BetterSQLite3Database): AuthOptions {
  // Build social providers dynamically based on env vars
  const socialProviders: Record<string, any> = {};

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
    logger.info('Google OAuth provider enabled');
  }

  return {
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
          after: async (user: { id: string; email?: string | null }) => {
            const normalizedAdminEmail = ADMIN_EMAIL?.toLowerCase();
            const normalizedUserEmail = user.email?.toLowerCase();

            if (normalizedAdminEmail && normalizedUserEmail === normalizedAdminEmail) {
              // Promote to admin role
              await drizzleDb
                .update(users)
                .set({ role: 'admin' })
                .where(eq(users.id, user.id));
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
  };
}

export type Auth = Omit<BaseAuth, 'api'> & { api: AuthApi };
type BaseAuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
export type AuthUser = BaseAuthSession['user'] & BetterAuthUser & { role?: string | null };
export type AuthSessionData = BaseAuthSession['session'] & BetterAuthSession & {
  activeOrganizationId?: string | null;
};
export interface AuthSession {
  user: AuthUser;
  session: AuthSessionData;
}

/**
 * Create a BetterAuth instance wired to our Drizzle/SQLite database.
 *
 * Plugins: organization, bearer, admin
 * Social providers: Google (when GOOGLE_CLIENT_ID is set)
 */
export function createAuth(drizzleDb: BetterSQLite3Database): Auth {
  const auth = betterAuth(buildAuthOptions(drizzleDb));

  return auth as Auth;
}
