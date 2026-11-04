import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Card, Notice } from "../../components/ui";
import { useAccess, useDeleteWebsite, useSiteId, useWebsite } from "./lib/hooks";
import { ConfirmDialog, QueryState, SettingsLayout } from "./lib/ui";

/** Website settings > Delete website: owners only, confirmed by typing the domain. */
export default function DangerZonePage() {
  const siteId = useSiteId();
  const website = useWebsite(siteId);
  const access = useAccess(siteId);
  const remove = useDeleteWebsite(siteId);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const w = website.data;
  return (
    <SettingsLayout siteId={siteId} domain={w?.domain}>
      {w ? (
        <Card title="Delete website" className="border-error/40">
          <div className="space-y-3 text-sm">
            <p className="text-muted">
              Deletes {w.domain} with all its pageviews, sessions, visitors, goals, payments,
              funnels, notes, API keys, invites and integrations. The tracking script stops being
              accepted at once; stored data is removed in the background. This cannot be undone.
            </p>
            {access.isOwner ? (
              <Button variant="danger" onClick={() => setOpen(true)}>
                Delete {w.domain}
              </Button>
            ) : (
              <Notice>Only an owner of this website can delete it.</Notice>
            )}
          </div>
          <ConfirmDialog
            open={open}
            title={`Delete ${w.domain}?`}
            confirmLabel="Delete website"
            confirmText={w.domain}
            pending={remove.isPending}
            error={remove.error}
            onCancel={() => setOpen(false)}
            onConfirm={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  setOpen(false);
                  void navigate({ to: "/app" });
                },
              })
            }
          >
            <p>
              Every visitor, payment and setting of this website is deleted permanently. Team
              members lose access immediately.
            </p>
          </ConfirmDialog>
        </Card>
      ) : (
        <QueryState query={website} />
      )}
    </SettingsLayout>
  );
}
