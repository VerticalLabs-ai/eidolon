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
 *
 * In dev the UI and API run on different ports, so we need to pass
 * the full UI origin so BetterAuth redirects back to the SPA.
 */
export function signInWithGoogle(callbackURL = "/") {
  // Ensure the callback is a full URL pointing at the UI origin
  const fullCallbackURL = callbackURL.startsWith("http")
    ? callbackURL
    : new URL(callbackURL, window.location.origin).toString();

  return authClient.signIn.social({
    provider: "google",
    callbackURL: fullCallbackURL,
  });
}
