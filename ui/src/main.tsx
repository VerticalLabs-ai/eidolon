import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider } from "@clerk/clerk-react";
import { App } from "./App";
import { CLERK_PUBLISHABLE_KEY } from "./lib/auth";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

if (!CLERK_PUBLISHABLE_KEY) {
  // Fail loudly in the browser console rather than rendering a confusingly
  // broken UI — Clerk's components all throw at use-time without a key.
  // eslint-disable-next-line no-console
  console.error(
    "Clerk publishable key is missing. Run `vercel env pull .env.local` " +
      "or set VITE_CLERK_PUBLISHABLE_KEY before building.",
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      // Keep Clerk's sign-in / sign-up flows routed within the SPA.
      signInUrl="/login"
      signUpUrl="/register"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
    >
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ClerkProvider>
  </StrictMode>,
);
