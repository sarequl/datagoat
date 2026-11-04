import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useSetup, useSetupStatus } from "../../api/hooks";
import { AuthLayout } from "../../components/AuthLayout";
import { Button, Field, Input, Notice, Spinner } from "../../components/ui";

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** First-run setup: `/setup?token=<SETUP_TOKEN>` creates the first owner and optionally a website. */
export default function SetupPage() {
  const navigate = useNavigate();
  const status = useSetupStatus();
  const setup = useSetup();
  const [token, setToken] = useState(
    () => new URLSearchParams(window.location.search).get("token") ?? "",
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");

  if (status.isPending) return <Spinner />;
  if (status.error) {
    return (
      <AuthLayout title="DataGoat is not ready">
        <Notice tone="error">{status.error.message}</Notice>
        <Button className="mt-4 w-full" variant="secondary" onClick={() => void status.refetch()}>
          Try again
        </Button>
      </AuthLayout>
    );
  }
  if (status.data && !status.data.needsSetup) {
    return (
      <AuthLayout title="Setup complete">
        <p className="text-sm text-muted">This DataGoat instance already has an owner.</p>
        <Button className="mt-4 w-full" onClick={() => void navigate({ to: "/login" })}>
          Go to sign in
        </Button>
      </AuthLayout>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setup.mutate(
      {
        token,
        email,
        password,
        name: name || null,
        ...(domain ? { website: { domain, timezone: browserTimezone() } } : {}),
      },
      {
        onSuccess: (result) => {
          const first = result.website?.websiteId;
          if (first)
            void navigate({ to: "/app/$siteId/settings/general", params: { siteId: first } });
          else void navigate({ to: "/app/new-site" });
        },
      },
    );
  };

  return (
    <AuthLayout title="Set up DataGoat" subtitle="Create the owner account for this install.">
      <form className="space-y-4" onSubmit={submit}>
        {status.data?.configErrors.length ? (
          <Notice tone="error">
            Fix the Worker secrets first: {status.data.configErrors.join("; ")}.
          </Notice>
        ) : null}
        {setup.error ? <Notice tone="error">{setup.error.message}</Notice> : null}
        <Field label="Setup token" hint="The SETUP_TOKEN secret. The setup link fills it in.">
          <Input
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label="First website (optional)" hint="Domain only, e.g. example.com">
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com"
          />
        </Field>
        <Button type="submit" className="w-full" disabled={setup.isPending}>
          {setup.isPending ? "Creating…" : "Create owner account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
