import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { InviteInfo, Me } from "../../../../shared/api-types";
import { api, apiGet } from "../../api/client";
import { queryKeys } from "../../api/hooks";
import { AuthLayout } from "../../components/AuthLayout";
import { Button, Field, Input, Notice, Spinner } from "../../components/ui";

export default function InvitePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => apiGet<InviteInfo>(`/api/auth/invites/${token}`),
    retry: false,
  });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (invite.isPending) return <Spinner />;
  if (invite.error || !invite.data) {
    return (
      <AuthLayout title="Invitation unavailable">
        <Notice tone="error">{invite.error?.message ?? "This invitation is not valid."}</Notice>
      </AuthLayout>
    );
  }
  const info = invite.data;
  const needsAccount = !info.userExists;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<Me & { websiteId: string }>(
        `/api/auth/invites/${token}/accept`,
        needsAccount ? { name: name || null, password } : {},
      );
      qc.setQueryData(queryKeys.me, res.data);
      void navigate({ to: "/app/$siteId/overview", params: { siteId: res.data.websiteId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout
      title={`Join ${info.website.name ?? info.website.domain}`}
      subtitle={`${info.invitedBy?.name ?? info.invitedBy?.email ?? "Someone"} invited ${info.email} as ${info.role}.`}
    >
      <form className="space-y-4" onSubmit={submit}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {needsAccount ? (
          <>
            <Field label="Your name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Choose a password" hint="At least 8 characters.">
              <Input
                type="password"
                minLength={8}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </>
        ) : info.signedInAs === info.email ? null : (
          <Notice>Sign in as {info.email} first, then open this link again.</Notice>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          Accept invitation
        </Button>
      </form>
    </AuthLayout>
  );
}
