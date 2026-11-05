import { useState } from "react";
import type { ShareLink } from "../../../../shared/api-types";
import { Button, Card, Input, Notice } from "../../components/ui";
import {
  DEFAULT_WIDGET,
  embedCode,
  PERIOD_LABELS,
  WIDGET_LABELS,
  WIDGET_PERIODS,
  WIDGET_SIZE,
  WIDGET_TYPES,
  type WidgetOptions,
  type WidgetPeriod,
  type WidgetType,
  widgetUrl,
} from "../public/widget-options";
import {
  useAccess,
  useShareAction,
  useShareLink,
  useSiteId,
  useUpdateWebsite,
  useWebsite,
} from "./lib/hooks";
import {
  CodeBlock,
  ConfirmDialog,
  CopyField,
  Field,
  PageHeader,
  QueryState,
  ReadOnlyNotice,
  Select,
  Toggle,
} from "./lib/ui";

/** DataFast's Widgets tab: pick a widget, its period, theme, colour and size; copy the iframe. */
function WidgetsCard({ token, siteName }: { token: string; siteName: string }) {
  const [o, setO] = useState<WidgetOptions>(DEFAULT_WIDGET);
  const [size, setSize] = useState(WIDGET_SIZE[DEFAULT_WIDGET.type]);
  const origin = window.location.origin;
  const title = `${siteName} ${WIDGET_LABELS[o.type].toLowerCase()}`;
  return (
    <Card title="Widgets">
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Show your numbers on any website: pick a widget, adjust it, and paste the code where it
          should appear. Widgets use this share link; turning sharing off or creating a new link
          stops them.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Widget">
            <Select
              value={o.type}
              onChange={(e) => {
                const type = e.target.value as WidgetType;
                setO({ ...o, type });
                setSize(WIDGET_SIZE[type]);
              }}
            >
              {WIDGET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {WIDGET_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Period">
            <Select
              value={o.period}
              disabled={o.type === "live"}
              onChange={(e) => setO({ ...o, period: e.target.value as WidgetPeriod })}
            >
              {WIDGET_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Theme">
            <Select
              value={o.theme}
              onChange={(e) => setO({ ...o, theme: e.target.value === "light" ? "light" : "dark" })}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </Select>
          </Field>
          <Field label="Colour">
            <input
              type="color"
              value={`#${o.color}`}
              onChange={(e) => setO({ ...o, color: e.target.value.replace("#", "").toLowerCase() })}
              className="h-9 w-full cursor-pointer rounded-md border border-line bg-surface"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Width">
              <Input
                type="number"
                min={160}
                max={1200}
                value={size.width}
                onChange={(e) => setSize({ ...size, width: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label="Height">
              <Input
                type="number"
                min={80}
                max={800}
                value={size.height}
                onChange={(e) => setSize({ ...size, height: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border border-line bg-surface-2 p-3">
          <iframe
            key={widgetUrl(origin, token, o)}
            src={widgetUrl(origin, token, o)}
            width={size.width}
            height={size.height}
            title={`${title} preview`}
            className="max-w-full rounded-xl border-0"
          />
        </div>
        <CodeBlock code={embedCode(origin, token, o, size, title)} label="widget embed code" wrap />
      </div>
    </Card>
  );
}

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
      {data?.enabled && data.token ? (
        <WidgetsCard
          token={data.token}
          siteName={website.data?.name ?? website.data?.domain ?? "Website"}
        />
      ) : null}
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
