import { Link } from "@tanstack/react-router";
import { type FormEvent, useMemo, useState } from "react";
import type { Website, WebsiteUpdate } from "../../../../shared/api-types";
import { Card, Input, Notice } from "../../components/ui";
import {
  currencyOptions,
  GOAL_NAME_RE,
  isValidHostname,
  normaliseHostname,
  timezoneOptions,
} from "./lib/format";
import {
  changedFields,
  useAccess,
  useSiteId,
  useTrackedGoals,
  useUpdateWebsite,
  useWebsite,
} from "./lib/hooks";
import { htmlSnippet, variantFor } from "./lib/snippets";
import {
  CodeBlock,
  ConfirmDialog,
  CopyField,
  Field,
  QueryState,
  RadioCards,
  ReadOnlyNotice,
  SaveRow,
  Select,
  SettingsLayout,
  Toggle,
} from "./lib/ui";

/** Website settings > General: details, #1 KPI, email reports, tracking IDs (DataFast parity). */
export default function GeneralSettingsPage() {
  const siteId = useSiteId();
  const website = useWebsite(siteId);
  const access = useAccess(siteId);
  return (
    <SettingsLayout siteId={siteId} domain={website.data?.domain}>
      {website.data ? (
        <div className="space-y-5">
          {!access.canEditSettings ? (
            <ReadOnlyNotice role={access.role} action="change settings" />
          ) : null}
          <DetailsCard website={website.data} disabled={!access.canEditSettings} />
          <KpiCard website={website.data} disabled={!access.canEditSettings} />
          <ReportsCard website={website.data} disabled={!access.canEditSettings} />
          <IdentifiersCard website={website.data} />
        </div>
      ) : (
        <QueryState query={website} />
      )}
    </SettingsLayout>
  );
}

type DetailsDraft = Pick<Website, "name" | "domain" | "timezone" | "currency" | "logo">;

function DetailsCard({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  const original: DetailsDraft = {
    name: website.name,
    domain: website.domain,
    timezone: website.timezone,
    currency: website.currency,
    logo: website.logo,
  };
  const [draft, setDraft] = useState<DetailsDraft>(original);
  const fromWebsite = (w: Website): DetailsDraft => ({
    name: w.name,
    domain: w.domain,
    timezone: w.timezone,
    currency: w.currency,
    logo: w.logo,
  });
  const [domainError, setDomainError] = useState<string | null>(null);
  const timezones = useMemo(() => timezoneOptions(website.timezone), [website.timezone]);
  const currencies = useMemo(() => currencyOptions(website.currency), [website.currency]);
  const changes = changedFields(original, draft);
  const dirty = Object.keys(changes).length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const domain = normaliseHostname(draft.domain);
    if (!isValidHostname(domain)) {
      setDomainError("Enter a domain like example.com, without https:// or a path.");
      return;
    }
    const body: WebsiteUpdate = changedFields(original, { ...draft, domain });
    if (body.name !== undefined) body.name = body.name?.trim() || null;
    if (body.logo !== undefined) body.logo = body.logo?.trim() || null;
    update.mutate(body, { onSuccess: (w) => setDraft(fromWebsite(w)) });
  };

  return (
    <Card title="Website">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        <Field label="Name" hint="Shown in the website switcher and reports.">
          <Input
            value={draft.name ?? ""}
            maxLength={100}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={website.domain}
          />
        </Field>
        <Field
          label="Domain"
          error={domainError}
          hint="Your root domain. Update data-domain in the script if you change it."
        >
          <Input
            required
            value={draft.domain}
            disabled={disabled}
            onChange={(e) => {
              setDraft({ ...draft, domain: e.target.value });
              setDomainError(null);
            }}
          />
        </Field>
        <Field label="Timezone" hint="Days and hours in reports follow this timezone.">
          <Select
            value={draft.timezone}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency" hint="Revenue from every provider is converted to this currency.">
          <Select
            value={draft.currency}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
          >
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field
            label="Logo URL (optional)"
            hint="An https:// image shown on the public dashboard."
          >
            <Input
              type="url"
              value={draft.logo ?? ""}
              disabled={disabled}
              placeholder="https://example.com/logo.png"
              onChange={(e) => setDraft({ ...draft, logo: e.target.value })}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <SaveRow
            dirty={dirty}
            pending={update.isPending}
            error={update.error}
            saved={update.isSuccess}
            disabled={disabled}
          />
        </div>
      </form>
    </Card>
  );
}

const KPI_COLORS = [
  { value: "orange", label: "Orange" },
  { value: "coral", label: "Coral" },
  { value: "blue", label: "Blue" },
  { value: "teal", label: "Teal" },
  { value: "green", label: "Green" },
  { value: "purple", label: "Purple" },
  { value: "pink", label: "Pink" },
  { value: "yellow", label: "Yellow" },
] as const;

function KpiCard({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  const goals = useTrackedGoals(website._id);
  const currentGoal = website.kpi && website.kpi !== "revenue" ? website.kpi : null;
  const [kind, setKind] = useState<"revenue" | "goal">(currentGoal ? "goal" : "revenue");
  const [goal, setGoal] = useState(currentGoal ?? "");
  const [color, setColor] = useState(website.kpiColorScheme ?? "orange");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextKpi = kind === "revenue" ? null : goal.trim().toLowerCase();
  const dirty = nextKpi !== currentGoal || color !== (website.kpiColorScheme ?? "orange");
  const goalNames = (goals.data ?? []).map((g) => g.name).filter((n) => n !== "pageview");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (kind === "goal" && !GOAL_NAME_RE.test(nextKpi ?? "")) {
      setError("Pick a goal, or type a goal name (a-z, 0-9, _, - or :).");
      return;
    }
    setError(null);
    setConfirming(true);
  };

  return (
    <Card title="#1 KPI">
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-sm text-muted">
          The metric highlighted across the dashboard. Source, page, location and device cards show
          attribution for it. Choose a goal such as <code>signup</code> or{" "}
          <code>trial_started</code> when revenue is not the best signal yet.
        </p>
        <RadioCards
          legend="Main KPI"
          name="kpi-kind"
          value={kind}
          onChange={setKind}
          disabled={disabled}
          options={[
            {
              value: "revenue",
              label: "Revenue",
              description: "Payments from connected providers and the Payments API.",
            },
            {
              value: "goal",
              label: "Goal",
              description: "A custom goal tracked with window.datagoat() or data-fast-goal.",
            },
          ]}
        />
        {kind === "goal" ? (
          <>
            <Field
              label="Goal"
              error={error}
              hint={
                goalNames.length
                  ? "Goals seen on this website. You can also type a goal you have not tracked yet."
                  : "No goals tracked yet. Type the goal name you will send."
              }
            >
              <Input
                list="kpi-goal-options"
                value={goal}
                disabled={disabled}
                placeholder="signup"
                onChange={(e) => {
                  setGoal(e.target.value);
                  setError(null);
                }}
              />
            </Field>
            <datalist id="kpi-goal-options">
              {goalNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </>
        ) : null}
        <Field label="Colour scheme" hint="Colour of the KPI bars and series.">
          <Select value={color} disabled={disabled} onChange={(e) => setColor(e.target.value)}>
            {KPI_COLORS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <SaveRow
          dirty={dirty}
          pending={update.isPending}
          error={update.error}
          saved={update.isSuccess}
          disabled={disabled}
        />
      </form>
      <ConfirmDialog
        open={confirming}
        title="Change your #1 KPI?"
        tone="primary"
        confirmLabel="Change KPI"
        pending={update.isPending}
        error={update.error}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          update.mutate(
            { kpi: nextKpi ?? "revenue", kpiColorScheme: color },
            { onSuccess: () => setConfirming(false) },
          )
        }
      >
        <p>
          The dashboard will highlight{" "}
          <strong className="text-text">{nextKpi ? `the ${nextKpi} goal` : "revenue"}</strong> and
          attribute it across sources, pages, locations and devices. You can change it back any
          time.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function ReportsCard({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  return (
    <Card title="Email reports">
      <div className="space-y-4">
        <Toggle
          label="Weekly report"
          description="Every Monday: visitors, revenue, KPIs, top sources and countries for the past week."
          checked={website.sendWeeklyReports}
          disabled={disabled || update.isPending}
          onChange={(v) => update.mutate({ sendWeeklyReports: v })}
        />
        <Toggle
          label="Traffic spike alert"
          description="An email when traffic is far above normal, so you can react to a viral post."
          checked={website.sendViralTrafficAlerts}
          disabled={disabled || update.isPending}
          onChange={(v) => update.mutate({ sendViralTrafficAlerts: v })}
        />
        <p className="text-xs text-muted">
          Reports go to the website's owners and members. Email needs a provider configured for this
          DataGoat instance; custom goal and sale alerts live on the{" "}
          <Link
            to="/app/$siteId/alerts"
            params={{ siteId: website._id }}
            className="text-primary-text underline"
          >
            Alerts
          </Link>{" "}
          page.
        </p>
        {update.error ? <Notice tone="error">{update.error.message}</Notice> : null}
      </div>
    </Card>
  );
}

function IdentifiersCard({ website }: { website: Website }) {
  const snippet = htmlSnippet({
    trackingId: website.trackingId,
    domain: website.domain,
    origin: window.location.origin,
    variant: variantFor(website.privacyMode, false),
  });
  return (
    <Card title="Tracking script">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Add this to the &lt;head&gt; of every page. Step-by-step guides for Next.js, WordPress,
          Shopify, Tag Manager and more are on the{" "}
          <Link
            to="/app/$siteId/settings/install"
            params={{ siteId: website._id }}
            className="text-primary-text underline"
          >
            Installation
          </Link>{" "}
          page.
        </p>
        <CodeBlock code={snippet} label="tracking snippet" />
        <div className="grid gap-4 sm:grid-cols-2">
          <CopyField
            visibleLabel
            value={website.trackingId}
            label="Website ID"
            hint="data-website-id in the script."
          />
          <CopyField
            visibleLabel
            value={website._id}
            label="API website ID"
            hint="websiteId for API calls with account tokens."
          />
        </div>
      </div>
    </Card>
  );
}
