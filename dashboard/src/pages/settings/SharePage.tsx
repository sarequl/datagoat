import { useState } from "react";
import type { ShareLink } from "../../../../shared/api-types";
import { Button, Card, Notice } from "../../components/ui";
import {
  useAccess,
  useShareAction,
  useShareLink,
  useSiteId,
  useUpdateWebsite,
  useWebsite,
} from "./lib/hooks";
import { ConfirmDialog, CopyField, PageHeader, QueryState, ReadOnlyNotice, Toggle } from "./lib/ui";

function shareUrl(link: ShareLink, origin = window.location.origin): string | null {
  const path = link.url ?? (link.token ? `/share/${link.token}` : null);
  return path ? new URL(path, origin).toString() : null;
}

/** Share link: a public, read-only dashboard (enable, copy, rotate, revoke, show revenue). */
export default function SharePage() {
  const siteId = useSiteId();
  const access = useAccess(siteId);
  const link = useShareLink(siteId);
  const website = useWebsite(siteId);
  const action = useShareAction(siteId);
  const update = useUpdateWebsite(siteId);
  const [confirm, setConfirm] = useState<"rotate" | "disable" | null>(null);
  const disabled = !access.canEditSettings;
  const data = link.data;
  const url = data ? shareUrl(data) : null;
  const showRevenue = website.data?.isPublicDataEnabled ?? data?.isPublicDataEnabled ?? false;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Share link"
        description="Share your analytics with anyone, no account needed: the overview, sources, pages, countries and the realtime map, read-only."
      />
      {disabled ? <ReadOnlyNotice role={access.role} action="change the share link" /> : null}
      <Card title="Public dashboard">
        {data ? (
          <div className="space-y-4 text-sm">
            {data.enabled && url ? (
              <>
                <Notice tone="success">Anyone with this link can view the dashboard.</Notice>
                <CopyField value={url} label="Share link" />
                <div className="flex flex-wrap gap-2">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center rounded-md border border-line px-3 py-2 hover:bg-surface-2"
                  >
                    Open public dashboard
                  </a>
                  {!disabled ? (
                    <>
                      <Button variant="secondary" onClick={() => setConfirm("rotate")}>
                        Create a new link
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-error-text"
                        onClick={() => setConfirm("disable")}
                      >
                        Turn off sharing
                      </Button>
                    </>
                  ) : null}
                </div>
                <div className="border-t border-line pt-4">
                  <Toggle
                    label="Show revenue"
                    description="Off by default: the public dashboard shows traffic only. Turn on to also show revenue, payments and revenue per visitor."
                    checked={showRevenue}
                    disabled={disabled || update.isPending}
                    onChange={(v) => update.mutate({ isPublicDataEnabled: v })}
                  />
                  {update.error ? (
                    <div className="mt-2">
                      <Notice tone="error">{update.error.message}</Notice>
                    </div>
                  ) : null}
                </div>
                <p className="text-xs text-muted">
                  Never shown publicly: visitor profiles, customer names and emails, notes and
                  settings.
                </p>
              </>
            ) : (
              <>
                <p className="text-muted">Sharing is off. Only your team can see this website.</p>
                {!disabled ? (
                  <Button disabled={action.isPending} onClick={() => action.mutate("enable")}>
                    {action.isPending ? "Creating…" : "Create share link"}
                  </Button>
                ) : null}
              </>
            )}
            {action.error && !confirm ? <Notice tone="error">{action.error.message}</Notice> : null}
          </div>
        ) : (
          <QueryState query={link} />
        )}
      </Card>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "rotate" ? "Create a new share link?" : "Turn off sharing?"}
        confirmLabel={confirm === "rotate" ? "Create new link" : "Turn off"}
        tone={confirm === "rotate" ? "primary" : "danger"}
        pending={action.isPending}
        error={action.error}
        onCancel={() => {
          setConfirm(null);
          action.reset();
        }}
        onConfirm={() =>
          confirm &&
          action.mutate(confirm === "rotate" ? "rotate" : "disable", {
            onSuccess: () => setConfirm(null),
          })
        }
      >
        <p>
          {confirm === "rotate"
            ? "The current link stops working at once. Anyone you shared it with needs the new one."
            : "The link stops working at once. You can create a new one later."}
        </p>
      </ConfirmDialog>
    </div>
  );
}
