import { createClerkClient, type ClerkClient } from '@clerk/backend';
import logger from './utils/logger.js';

const DEFAULT_AUTHORIZED_EMAILS = ['matt@verticallabs.ai'];
const DEFAULT_ADMIN_EMAILS = ['matt@verticallabs.ai'];

// ---------------------------------------------------------------------------
// Auth types (kept stable across the BetterAuth → Clerk migration so the
// middleware + routes don't need to care about the underlying provider).
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  imageUrl?: string | null;
}

export interface AuthSessionData {
  id: string;
  userId: string;
  activeOrganizationId?: string | null;
  activeOrganizationRole?: string | null;
}

export interface AuthSession {
  user: AuthUser;
  session: AuthSessionData;
}

// ---------------------------------------------------------------------------
// Clerk client singleton
// ---------------------------------------------------------------------------

let cachedClient: ClerkClient | null = null;

function normalizeEmail(email: string | null | undefined): string {
  return email?.trim().toLowerCase() ?? '';
}

function parseEmailList(value: string | undefined, defaults: string[]): Set<string> {
  const raw = value?.trim();
  const emails = raw
    ? raw.split(',').map(normalizeEmail)
    : defaults.map(normalizeEmail);

  return new Set(emails.filter(Boolean));
}

export function getAuthorizedEmails(): Set<string> {
  return new Set([
    ...parseEmailList(process.env.EIDOLON_AUTHORIZED_EMAILS, DEFAULT_AUTHORIZED_EMAILS),
    ...getAdminEmails(),
  ]);
}

export function getAdminEmails(): Set<string> {
  return parseEmailList(process.env.EIDOLON_ADMIN_EMAILS, DEFAULT_ADMIN_EMAILS);
}

export function isAuthorizedEmail(email: string | null | undefined): boolean {
  return getAuthorizedEmails().has(normalizeEmail(email));
}

export function resolveUserRole(options: {
  email: string | null | undefined;
  metadataRole?: string | null;
}): string | null {
  if (getAdminEmails().has(normalizeEmail(options.email))) {
    return 'admin';
  }

  return options.metadataRole ?? null;
}

function getClerkClient(): ClerkClient | null {
  if (cachedClient) return cachedClient;

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    logger.warn(
      'CLERK_SECRET_KEY is not set — authenticated requests will be rejected. ' +
        'Run `vercel integration add clerk` or set the key manually.',
    );
    return null;
  }

  cachedClient = createClerkClient({
    secretKey,
    publishableKey:
      process.env.CLERK_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a Clerk session token on an incoming Express request. Returns an
 * AuthSession when the request is authenticated, or null if it's anonymous /
 * the token is invalid. Never throws — callers decide whether to 401 or
 * continue.
 *
 * The function shapes a web-standard Request from the Express req so Clerk's
 * `authenticateRequest` can read the session cookie or Authorization header.
 */
export async function authenticateRequest(
  req: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  },
): Promise<AuthSession | null> {
  const client = getClerkClient();
  if (!client) return null;

  // Build a web-standard Request for Clerk to inspect. The host/protocol
  // don't matter for token verification — what matters is that the
  // Authorization header and session cookie make it through.
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  const url = new URL(
    req.url.startsWith('http') ? req.url : `http://internal${req.url}`,
  );
  const standardRequest = new Request(url, {
    method: req.method,
    headers,
  });

  const result = await client.authenticateRequest(standardRequest);
  if (!result.isAuthenticated) return null;

  const auth = result.toAuth();
  if (!auth || !auth.userId) return null;

  // Pull user detail on-demand — Clerk's authenticateRequest doesn't embed
  // email/name by default. For routes that only need the id we could skip
  // this, but the middleware attaches a richer user object for audit logs.
  let user: AuthUser;
  try {
    const clerkUser = await client.users.getUser(auth.userId);
    const email = normalizeEmail(clerkUser.primaryEmailAddress?.emailAddress);

    if (!isAuthorizedEmail(email)) {
      logger.warn(
        { userId: auth.userId, email },
        'Auth: rejected Clerk user because email is not authorized',
      );
      return null;
    }

    const metadataRole = (clerkUser.publicMetadata as { role?: string } | null)?.role;
    user = {
      id: clerkUser.id,
      name:
        [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') ||
        clerkUser.username ||
        email ||
        clerkUser.id,
      email,
      role: resolveUserRole({ email, metadataRole }),
      imageUrl: clerkUser.imageUrl ?? null,
    };
  } catch (err) {
    logger.debug(
      { err, userId: auth.userId },
      'Clerk users.getUser failed — falling back to id-only user',
    );
    user = { id: auth.userId, name: auth.userId, email: '' };
  }

  return {
    user,
    session: {
      id: auth.sessionId ?? `sess:${auth.userId}`,
      userId: auth.userId,
      activeOrganizationId: auth.orgId ?? null,
      activeOrganizationRole: auth.orgRole ?? null,
    },
  };
}
