import { useState } from "react";
import { useNavigate, useLocation, Link, type Location } from "react-router-dom";
import { signIn, signInWithGoogle } from "@/lib/auth";
import { GoogleIcon } from "@/components/icons/GoogleIcon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

interface LocationState {
  from?: {
    pathname: string;
  };
}

export function Login() {
  const navigate = useNavigate();
  const location: Location<LocationState> = useLocation();
  const from = location.state?.from?.pathname || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message || "Sign in failed");
      } else {
        navigate(from, { replace: true });
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    setError("");
    setGoogleLoading(true);
    try {
      await signInWithGoogle(from);
    } catch {
      setError("Google sign in failed");
      setGoogleLoading(false);
    }
  }

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

        {/* Google OAuth */}
        <Button
          variant="secondary"
          size="lg"
          className="w-full mb-6"
          onClick={handleGoogleSignIn}
          loading={googleLoading}
          icon={<GoogleIcon />}
        >
          Continue with Google
        </Button>

        <div className="relative mb-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-white/[0.08]" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-background px-3 text-text-secondary/60">or</span>
          </div>
        </div>

        {/* Email/password */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="email"
          />

          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            required
            autoComplete="current-password"
          />

          {error && (
            <p className="text-xs text-error bg-error/10 border border-error/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <Button
            type="submit"
            size="lg"
            loading={loading}
            className="w-full"
          >
            Sign in
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-text-secondary">
          Don&apos;t have an account?{" "}
          <Link
            to="/register"
            className="text-accent hover:text-accent/80 transition-colors"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
