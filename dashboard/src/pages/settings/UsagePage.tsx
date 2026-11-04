import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Usage, Website } from "../../../../shared/api-types";
import { Card, Input, Notice } from "../../components/ui";
import { formatBytes, formatDate, formatNumber } from "./lib/format";
import { useAccess, useSiteId, useUpdateWebsite, useUsage, useWebsite } from "./lib/hooks";
import {
  ConfirmDialog,
  Field,
  Meter,
  PageHeader,
  QueryState,
  ReadOnlyNotice,
  SaveRow,
  Select,
} from "./lib/ui";

/** Workers Free plan: 100,000 requests per day (each tracked event is one request). */
const FREE_WORKER_REQUESTS_PER_DAY = 100_000;
const FREE_ROWS_READ_PER_DAY = 5_000_000;

/** Usage & data: events and D1 usage against the Cloudflare plan limits, and data retention. */
export default function UsagePage() {
  const siteId = useSiteId();
  const usage = useUsage(siteId);
  const website = useWebsite(siteId);
  const access = useAccess(siteId);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Usage & data"
        description="DataGoat runs in your Cloudflare account, so the limits that matter are Cloudflare's. Nothing is billed by DataGoat."
      />
      {usage.data ? (
        <UsageCards usage={usage.data} siteId={siteId} />
      ) : (
        <QueryState query={usage} />
      )}
      {website.data ? (
        <RetentionCard
          website={website.data}
          disabled={!access.canEditSettings}
          role={access.role}
        />
      ) : null}
    </div>
  );
}

function UsageCards({ usage, siteId }: { usage: Usage; siteId: string }) {
  const free = usage.plan === "free";
  const dbWarn = usage.databasePercentUsed >= 70;
  const writeShare = usage.estimatedDailyWriteLimit
    ? usage.last24h.estimatedRowsWritten / usage.estimatedDailyWriteLimit
    : 0;
  return (
    <>
      {dbWarn ? (
        <Notice tone="error">
          The database is {usage.databasePercentUsed.toFixed(0)}% full. Set a retention period below
          or add exclusions before it reaches the {formatBytes(usage.databaseLimitBytes)} limit,
          when new events can no longer be stored.
        </Notice>
      ) : null}
      {writeShare >= 0.8 ? (
        <Notice tone="error">
          This website alone used {Math.round(writeShare * 100)}% of the daily database write
          allowance in the last 24 hours. Exclude low-value pages or bots to stay under it.
        </Notice>
      ) : null}
      <Card title="Last 24 hours">
        <div className="space-y-5">
          <Meter
            label="Database rows written"
            value={usage.last24h.estimatedRowsWritten}
            limit={usage.estimatedDailyWriteLimit}
            display={`${formatNumber(usage.last24h.estimatedRowsWritten)} of ${formatNumber(usage.estimatedDailyWriteLimit)} per day (estimate)`}
          />
          {free ? (
            <Meter
              label="Tracked events (Worker requests)"
              value={usage.last24h.events}
              limit={FREE_WORKER_REQUESTS_PER_DAY}
              display={`${formatNumber(usage.last24h.events)} of ${formatNumber(FREE_WORKER_REQUESTS_PER_DAY)} requests per day`}
            />
          ) : (
            <p className="text-sm">
              <span className="font-medium">Tracked events:</span>{" "}
              {formatNumber(usage.last24h.events)}
            </p>
          )}
          <p className="text-sm text-muted">
            {formatNumber(usage.last24h.sessions)} sessions in the last 24 hours.{" "}
            {free
              ? `The Free plan also allows ${formatNumber(FREE_ROWS_READ_PER_DAY)} rows read per day for dashboards and the API. Limits reset at 00:00 UTC; other websites on this instance share them.`
              : "Workers Paid includes far higher limits; usage above them is billed by Cloudflare."}
          </p>
        </div>
      </Card>
      <Card title="Database">
        <div className="space-y-4">
          <Meter
            label="D1 database size"
            value={usage.databaseSizeBytes}
            limit={usage.databaseLimitBytes}
            display={`${formatBytes(usage.databaseSizeBytes)} of ${formatBytes(usage.databaseLimitBytes)}`}
          />
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {(
              [
                ["Events", usage.rows.events],
                ["Sessions", usage.rows.sessions],
                ["Visitors", usage.rows.visitors],
                ["Payments", usage.rows.payments],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-md border border-line p-3">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-base font-semibold">{formatNumber(n)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted">
            Plan:{" "}
            {usage.plan === "unknown"
              ? "not detected"
              : `Workers ${usage.plan === "free" ? "Free" : "Paid"}`}
            . Oldest stored event: {formatDate(usage.oldestEventAt)}. The database size covers every
            website on this instance.
          </p>
        </div>
      </Card>
      <Card title="Reduce usage">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>
            Exclude pages you do not need analytics for, such as <code>/app/*</code> for logged-in
            users or <code>/admin/*</code>, on the{" "}
            <Link
              to="/app/$siteId/settings/exclusions"
              params={{ siteId }}
              className="text-primary-text underline"
            >
              Exclusions
            </Link>{" "}
            tab. Keep checkout and thank-you pages tracked.
          </li>
          <li>Exclude countries you do not serve, and your own office IPs.</li>
          <li>
            Raise bot filtering to strict while your site is being spammed (
            <Link
              to="/app/$siteId/settings/tracking"
              params={{ siteId }}
              className="text-primary-text underline"
            >
              Tracking &amp; privacy
            </Link>
            ).
          </li>
          <li>Keep raw events for fewer days with the retention setting below.</li>
        </ul>
      </Card>
    </>
  );
}

const PRESETS = ["", "30", "90", "180", "365", "730", "1095"];

function RetentionCard({
  website,
  disabled,
  role,
}: {
  website: Website;
  disabled: boolean;
  role: Website["role"];
}) {
  const update = useUpdateWebsite(website._id);
  const current = website.retentionDays === null ? "" : String(website.retentionDays);
  const [choice, setChoice] = useState(PRESETS.includes(current) ? current : "custom");
  const [custom, setCustom] = useState(PRESETS.includes(current) ? "" : current);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = choice === "custom" ? custom.trim() : choice;
  const next = value === "" ? null : Number(value);
  const dirty = next !== website.retentionDays;
  const shrinking =
    next !== null && (website.retentionDays === null || next < website.retentionDays);

  const submit = () => {
    if (next !== null && (!Number.isInteger(next) || next < 30 || next > 36500)) {
      setError("Use a whole number of days between 30 and 36500.");
      return;
    }
    setError(null);
    if (shrinking) setConfirming(true);
    else update.mutate({ retentionDays: next });
  };

  return (
    <Card title="Data retention">
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {disabled && role ? <ReadOnlyNotice role={role} action="change retention" /> : null}
        <p className="text-sm text-muted">
          Raw events (pageviews and goals) older than this are deleted daily to keep the database
          small. Sessions, visitors and payments are always kept, so revenue attribution and
          long-term totals survive.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Keep raw events for">
            <Select
              value={choice}
              disabled={disabled}
              onChange={(e) => {
                setChoice(e.target.value);
                setError(null);
              }}
            >
              <option value="">Forever (default)</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="180">6 months</option>
              <option value="365">1 year</option>
              <option value="730">2 years</option>
              <option value="1095">3 years</option>
              <option value="custom">Custom…</option>
            </Select>
          </Field>
          {choice === "custom" ? (
            <Field label="Days" error={error} hint="30 to 36500">
              <Input
                type="number"
                min={30}
                max={36500}
                inputMode="numeric"
                value={custom}
                disabled={disabled}
                onChange={(e) => {
                  setCustom(e.target.value);
                  setError(null);
                }}
              />
            </Field>
          ) : null}
        </div>
        {error && choice !== "custom" ? <Notice tone="error">{error}</Notice> : null}
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
        title={`Keep only ${next ?? 0} days of events?`}
        confirmLabel="Save and delete older events"
        pending={update.isPending}
        error={update.error}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          update.mutate({ retentionDays: next }, { onSuccess: () => setConfirming(false) })
        }
      >
        <p>
          Events older than {next} days are deleted permanently at the next daily clean-up.
          Breakdowns that need raw events may no longer be available for that period.
        </p>
      </ConfirmDialog>
    </Card>
  );
}
