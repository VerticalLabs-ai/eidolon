import { useAuth, useUser } from "@clerk/clerk-react";

const ADMIN_EMAILS = new Set(["matt@verticallabs.ai"]);

function normalizeEmail(email: string | null | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

function resolveUserRole(email: string, metadataRole: string | null): string | null {
  if (ADMIN_EMAILS.has(email)) return "admin";
  return metadataRole;
}

/**
 * useSession — thin compatibility shim over Clerk's hooks. Returns an object
 * shaped roughly like BetterAuth's session so existing AuthGuard / nav code
 * keeps working after the migration.
 */
export function useSession() {
  const { isLoaded: userLoaded, user } = useUser();
  const { isLoaded: authLoaded, sessionId, orgId, orgRole } = useAuth();

  const isPending = !(userLoaded && authLoaded);

  if (isPending || !user) {
    return { data: null, isPending };
  }

  const email = normalizeEmail(user.primaryEmailAddress?.emailAddress);
  const metadataRole =
    (user.publicMetadata as { role?: string } | null)?.role ?? null;

  return {
    isPending: false,
    data: {
      user: {
        id: user.id,
        name:
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          user.username ||
          email ||
          user.id,
        email,
        image: user.imageUrl,
        role: resolveUserRole(email, metadataRole),
      },
      session: {
        id: sessionId ?? `sess:${user.id}`,
        userId: user.id,
        activeOrganizationId: orgId ?? null,
        activeOrganizationRole: orgRole ?? null,
      },
    },
  };
}

export const CLERK_PUBLISHABLE_KEY =
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ?? "";
