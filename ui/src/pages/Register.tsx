import { SignUp } from "@clerk/clerk-react";

export function Register() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-text-primary font-display tracking-tight">
            Eidolon
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            Create your account
          </p>
        </div>
        <SignUp
          routing="path"
          path="/register"
          signInUrl="/login"
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
