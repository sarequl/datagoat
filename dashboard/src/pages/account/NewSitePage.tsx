import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { CreatedWebsite } from "../../../../shared/api-types";
import { useCreateWebsite } from "../../api/hooks";
import { Button, Card, Field, Input, Notice } from "../../components/ui";

export function trackingSnippet(
  site: Pick<CreatedWebsite, "domain" | "trackingId">,
  origin = window.location.origin,
): string {
  return `<script defer data-website-id="${site.trackingId}" data-domain="${site.domain}" src="${origin}/js/script.js"></script>`;
}

/** Add a website and copy the tracking snippet (plan §12 step 1). */
export default function NewSitePage() {
  const navigate = useNavigate();
  const create = useCreateWebsite();
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedWebsite | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ domain, name: name || null, timezone }, { onSuccess: setCreated });
  };

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">Add a website</h1>
      {created ? (
        <Card title="Install the tracking script">
          <p className="mb-2 text-sm text-muted">
            Paste this into the &lt;head&gt; of every page on {created.domain}:
          </p>
          <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 text-xs">
            <code>{trackingSnippet(created)}</code>
          </pre>
          <Button
            className="mt-4"
            onClick={() =>
              void navigate({ to: "/app/$siteId/overview", params: { siteId: created.websiteId } })
            }
          >
            Go to dashboard
          </Button>
        </Card>
      ) : (
        <Card>
          <form className="space-y-4" onSubmit={submit}>
            {create.error ? <Notice tone="error">{create.error.message}</Notice> : null}
            <Field label="Domain" hint="Without https://, e.g. example.com">
              <Input
                required
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
              />
            </Field>
            <Field label="Name (optional)">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <p className="text-xs text-muted">
              Timezone: {timezone} (change it later in settings).
            </p>
            <Button type="submit" disabled={create.isPending}>
              Add website
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
