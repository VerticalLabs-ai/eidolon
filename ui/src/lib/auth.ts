import { createAuthClient } from "better-auth/react";
import { organizationClient, adminClient } from "better-auth/client/plugins";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authClient: any = createAuthClient({
  baseURL: window.location.origin,
  plugins: [
    organizationClient(),
    adminClient(),
  ],
});

export const useSession: typeof authClient.useSession = authClient.useSession;
export const signIn: typeof authClient.signIn = authClient.signIn;
export const signUp: typeof authClient.signUp = authClient.signUp;
export const signOut: typeof authClient.signOut = authClient.signOut;
export const useActiveOrganization: typeof authClient.useActiveOrganization = authClient.useActiveOrganization;
export const useListOrganizations: typeof authClient.useListOrganizations = authClient.useListOrganizations;

/**
 * Sign in with Google OAuth.
 * Redirects to Google's consent screen, then back to callbackURL.
 */
export function signInWithGoogle(callbackURL = "/") {
  return authClient.signIn.social({
    provider: "google",
    callbackURL,
  });
}
