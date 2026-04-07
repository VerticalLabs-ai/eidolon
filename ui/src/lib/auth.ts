import { createAuthClient } from "better-auth/react";
import { organizationClient, adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [
    organizationClient(),
    adminClient(),
  ],
});

export const useSession = authClient.useSession;
export const signIn = authClient.signIn;
export const signUp = authClient.signUp;
export const signOut = authClient.signOut;
export const useActiveOrganization = authClient.useActiveOrganization;
export const useListOrganizations = authClient.useListOrganizations;

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
