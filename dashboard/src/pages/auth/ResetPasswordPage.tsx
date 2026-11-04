import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api, apiGet } from "../../api/client";
import { AuthLayout } from "../../components/AuthLayout";
import { Button, Field, Input, Notice, Spinner } from "../../components/ui";

export default function ResetPasswordPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const link = useQuery({
    queryKey: ["password-reset", token],
    queryFn: () => apiGet<{ email: string }>(`/api/auth/password-resets/${token}`),
    retry: false,
  });
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (link.isPending) return <Spinner />;
  if (link.error) {
    return (
      <AuthLayout title="Reset link unavailable">
        <Notice tone="error">{link.error.message}</Notice>
      </AuthLayout>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/api/auth/password-resets/${token}`, { password });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <AuthLayout title="Choose a new password" subtitle={link.data?.email}>
      {done ? (
        <Notice tone="success">
          Password updated. <Link to="/login">Sign in</Link>
        </Notice>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field label="New password" hint="At least 8 characters.">
            <Input
              type="password"
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full">
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
