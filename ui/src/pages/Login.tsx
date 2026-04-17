import { SignIn } from "@clerk/clerk-react";

export function Login() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-text-primary font-display tracking-tight">
            Eidolon
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            Sign in to your account
          </p>
        </div>
        <SignIn
          routing="path"
          path="/login"
          signUpUrl="/register"
          fallbackRedirectUrl="/"
          appearance={{
            elements: {
              card: "bg-surface-raised border border-white/[0.06]",
              formButtonPrimary: "bg-accent text-surface hover:brightness-110",
            },
          }}
        />
      </div>
    </div>
  );
}
