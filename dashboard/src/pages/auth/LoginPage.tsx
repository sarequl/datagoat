import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { useLogin, useSetupStatus } from "../../api/hooks";
import { AuthLayout } from "../../components/AuthLayout";
import { Button, Field, Input, Notice } from "../../components/ui";

export default function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const setup = useSetupStatus();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (setup.data?.needsSetup) void navigate({ to: "/setup" });
  }, [setup.data, navigate]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => void navigate({ to: "/app" }) });
  };

  return (
    <AuthLayout title="Sign in to DataGoat">
      <form className="space-y-4" onSubmit={submit}>
        {setup.error ? <Notice tone="error">{setup.error.message}</Notice> : null}
        {login.error ? <Notice tone="error">{login.error.message}</Notice> : null}
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-xs text-muted">
          Forgot your password? Ask the operator to run <code>npm run reset-password</code>.{" "}
          <Link to="/setup" className="underline">
            First run?
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
