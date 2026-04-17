import { useAuth, useUser } from "@clerk/clerk-react";

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

  return {
    isPending: false,
    data: {
      user: {
        id: user.id,
        name:
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          user.username ||
          user.primaryEmailAddress?.emailAddress ||
          user.id,
        email: user.primaryEmailAddress?.emailAddress ?? "",
        image: user.imageUrl,
        role:
          (user.publicMetadata as { role?: string } | null)?.role ?? null,
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
