import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { MessageResult } from "../../../../shared/api-types";
import { ApiClientError, api } from "../../api/client";
import { AuthLayout } from "../../components/AuthLayout";
import { Button, Field, Input, Notice } from "../../components/ui";

/**
 * "Forgot password?": asks the server to email a one-time reset link
 * (`POST /api/auth/password-resets {email}`, docs/api/contract.md §11). The answer is the same
 * whether or not the account exists. Without an email provider the server answers 503 and its
 * message points to `npm run reset-password`, which is shown as is.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState(
    () => new URLSearchParams(window.location.search).get("email") ?? "",
  );
  const request = useMutation<MessageResult, Error, string>({
    mutationFn: async (address) =>
      (await api.post<MessageResult>("/api/auth/password-resets", { email: address })).data,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    request.mutate(email.trim());
  };

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your account email and we will send you a link to choose a new password."
    >
      {request.isSuccess ? (
        <div className="space-y-4">
          <Notice tone="success">{request.data.message}</Notice>
          <p className="text-center text-xs text-muted">
            The link works once and expires in one hour.{" "}
            <Link to="/login" className="underline">
              Back to sign in
            </Link>
          </p>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          {request.error ? (
            <Notice tone="error">
              {request.error instanceof ApiClientError && request.error.status === 429
                ? "Too many requests. Try again in a minute."
                : request.error.message}
            </Notice>
          ) : null}
          <Field label="Email">
            <Input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full" disabled={request.isPending}>
            {request.isPending ? "Sending…" : "Send reset link"}
          </Button>
          <p className="text-center text-xs text-muted">
            <Link to="/login" className="underline">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
