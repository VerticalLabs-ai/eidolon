import { Link } from "react-router-dom";

export function Register() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-text-primary font-display tracking-tight">
            Eidolon
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            Access is currently invite-only.
          </p>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-surface-raised p-6 text-center shadow-xl">
          <p className="text-sm leading-6 text-text-secondary">
            New account creation is disabled for this deployment.
          </p>
          <Link
            to="/login"
            className="mt-5 inline-flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-surface transition hover:brightness-110"
          >
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
