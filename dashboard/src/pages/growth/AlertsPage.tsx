import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import type {
  Alert,
  AlertChannel,
  AlertChannels,
  AlertCreateRequest,
  AlertHistoryEntry,
  AlertTriggerType,
} from "../../../../shared/api-types";
import { api, apiGet } from "../../api/client";
import { Button, Card, Field, Input, Notice, SecretInput, Spinner } from "../../components/ui";
import { fmtDate, fmtNumber, PageHeader, Select, Table, Toggle, useSiteId } from "./shared";

const TRIGGERS: Array<{ value: AlertTriggerType; label: string }> = [
  { value: "goal", label: "Goal completed" },
  { value: "new_sale", label: "New sale" },
  { value: "traffic_spike", label: "Traffic spike" },
  { value: "daily_digest", label: "Daily digest" },
  { value: "weekly_digest", label: "Weekly digest" },
];
const CHANNELS: Array<{ value: AlertChannel; label: string }> = [
  { value: "email", label: "Email" },
  { value: "telegram", label: "Telegram" },
  { value: "webhook", label: "Webhook" },
];

export function triggerLabel(a: Alert): string {
  switch (a.trigger.type) {
    case "goal":
      return `Goal “${a.trigger.goalName ?? ""}”`;
    case "new_sale":
      return a.trigger.includeFreeTrials ? "New sale or free trial" : "New sale";
    case "traffic_spike":
      return `Traffic spike (${a.trigger.multiplier ?? 4}x)`;
    case "daily_digest":
      return "Daily digest";
    case "weekly_digest":
      return "Weekly digest";
  }
}

function destinationLabel(a: Alert, channels?: AlertChannels): string {
  switch (a.destination.type) {
    case "email":
      return (
        a.destination.email ?? (channels?.email.defaultRecipients.join(", ") || "Website owners")
      );
    case "telegram":
      return `Telegram chat ${a.destination.chatId ?? ""}`;
    case "webhook":
      return a.destination.url ?? "Webhook";
  }
}

interface FormState {
  name: string;
  type: AlertTriggerType;
  goalName: string;
  multiplier: string;
  includeRenewals: boolean;
  includeFreeTrials: boolean;
  channel: AlertChannel;
  email: string;
  chatId: string;
  botToken: string;
  url: string;
  subject: string;
  message: string;
}

const EMPTY: FormState = {
  name: "",
  type: "goal",
  goalName: "",
  multiplier: "4",
  includeRenewals: true,
  includeFreeTrials: false,
  channel: "email",
  email: "",
  chatId: "",
  botToken: "",
  url: "",
  subject: "",
  message: "",
};

function fromAlert(a: Alert): FormState {
  return {
    ...EMPTY,
    name: a.name,
    type: a.trigger.type,
    goalName: a.trigger.goalName ?? "",
    multiplier: String(a.trigger.multiplier ?? 4),
    includeRenewals: a.trigger.includeRenewals ?? true,
    includeFreeTrials: a.trigger.includeFreeTrials ?? false,
    channel: a.destination.type,
    email: a.destination.email ?? "",
    chatId: a.destination.chatId ?? "",
    url: a.destination.url ?? "",
    subject: a.template.subject ?? "",
    message: a.template.message,
  };
}

export function toRequest(f: FormState, editing: boolean): AlertCreateRequest {
  const trigger: AlertCreateRequest["trigger"] = { type: f.type };
  if (f.type === "goal") trigger.goalName = f.goalName.trim();
  if (f.type === "traffic_spike") trigger.multiplier = Number(f.multiplier) || 4;
  if (f.type === "new_sale") {
    trigger.includeRenewals = f.includeRenewals;
    trigger.includeFreeTrials = f.includeFreeTrials;
  }
  const destination: NonNullable<AlertCreateRequest["destination"]> = { type: f.channel };
  if (f.channel === "email" && f.email.trim()) destination.email = f.email.trim();
  if (f.channel === "telegram") {
    destination.chatId = f.chatId.trim();
    if (f.botToken.trim()) destination.botToken = f.botToken.trim();
  }
  if (f.channel === "webhook") destination.url = f.url.trim();
  const template: NonNullable<AlertCreateRequest["template"]> = {};
  if (f.message.trim()) template.message = f.message.trim();
  if (f.subject.trim() || editing) template.subject = f.subject.trim();
  return { name: f.name.trim(), trigger, destination, template };
}

function AlertForm({
  siteId,
  channels,
  editing,
  onDone,
}: {
  siteId: string;
  channels: AlertChannels | undefined;
  editing: Alert | null;
  onDone: (secret?: string) => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(editing ? fromAlert(editing) : EMPTY);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useMutation({
    mutationFn: async () => {
      const body = toRequest(f, editing !== null);
      const res = editing
        ? await api.put<Alert[]>(`/api/v1/admin/websites/${siteId}/alerts/${editing.id}`, body)
        : await api.post<Alert[]>(`/api/v1/admin/websites/${siteId}/alerts`, body);
      return res.data[0];
    },
    onSuccess: (alert) => {
      void qc.invalidateQueries({ queryKey: ["alerts", siteId] });
      onDone(alert?.destination.signingSecret);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const emailOff = channels && !channels.email.configured;
  return (
    <form className="space-y-4" onSubmit={submit} aria-label={editing ? "Edit alert" : "New alert"}>
      {save.error ? <Notice tone="error">{save.error.message}</Notice> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name">
          <Input
            required
            maxLength={100}
            value={f.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="New sale"
          />
        </Field>
        <Select
          label="When"
          value={f.type}
          onChange={(v) => set("type", v as AlertTriggerType)}
          options={TRIGGERS}
        />
        {f.type === "goal" ? (
          <Field label="Goal name" hint="The goal sent with window.datagoat(…) or data-fast-goal">
            <Input
              required
              value={f.goalName}
              onChange={(e) => set("goalName", e.target.value)}
              placeholder="signup"
            />
          </Field>
        ) : null}
        {f.type === "traffic_spike" ? (
          <Field
            label="Multiplier"
            hint="Alert when an hour has this many times the usual hourly traffic"
          >
            <Input
              type="number"
              min={1.5}
              max={50}
              step={0.5}
              value={f.multiplier}
              onChange={(e) => set("multiplier", e.target.value)}
            />
          </Field>
        ) : null}
        {f.type === "new_sale" ? (
          <div className="space-y-2 md:col-span-2">
            <Toggle
              label="Include renewals"
              checked={f.includeRenewals}
              onChange={(v) => set("includeRenewals", v)}
            />
            <Toggle
              label="Include free trials"
              checked={f.includeFreeTrials}
              onChange={(v) => set("includeFreeTrials", v)}
            />
          </div>
        ) : null}
        <Select
          label="Send to"
          value={f.channel}
          onChange={(v) => set("channel", v as AlertChannel)}
          options={CHANNELS}
        />
        {f.channel === "email" ? (
          <Field
            label="Recipient (optional)"
            hint={
              emailOff
                ? "Email is not configured on this server: add RESEND_API_KEY or POSTMARK_SERVER_TOKEN and EMAIL_FROM."
                : `Defaults to the website owners${channels?.email.defaultRecipients.length ? ` (${channels.email.defaultRecipients.join(", ")})` : ""}.`
            }
          >
            <Input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
        ) : null}
        {f.channel === "telegram" ? (
          <>
            <Field
              label="Chat id"
              hint="Message your bot, then read the chat id from getUpdates, or use @channel"
            >
              <Input required value={f.chatId} onChange={(e) => set("chatId", e.target.value)} />
            </Field>
            <Field
              label="Bot token"
              hint={
                editing?.destination.hasBotToken
                  ? "Saved and encrypted. Choose Replace to paste a new token."
                  : channels?.telegram.hasDefaultBotToken
                    ? "Optional: the server has a default bot."
                    : "From @BotFather"
              }
            >
              <SecretInput
                stored={Boolean(editing?.destination.hasBotToken)}
                value={f.botToken}
                onChange={(v) => set("botToken", v)}
              />
            </Field>
          </>
        ) : null}
        {f.channel === "webhook" ? (
          <Field
            label="Webhook URL"
            hint="https only. Requests are signed with X-DataGoat-Signature."
          >
            <Input
              required
              type="url"
              value={f.url}
              onChange={(e) => set("url", e.target.value)}
              placeholder="https://hooks.example.com/datagoat"
            />
          </Field>
        ) : null}
        <Field label="Subject (optional)">
          <Input
            maxLength={200}
            value={f.subject}
            onChange={(e) => set("subject", e.target.value)}
          />
        </Field>
      </div>
      <Field
        label={f.type === "goal" ? "Message" : "Message (optional)"}
        hint={
          <>
            Variables:{" "}
            {(channels?.variables ?? ["goal", "country", "referrer"])
              .map((v) => `{{${v}}}`)
              .join(" ")}
          </>
        }
      >
        <textarea
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
          rows={3}
          minLength={f.message ? 10 : undefined}
          maxLength={2000}
          required={f.type === "goal"}
          value={f.message}
          onChange={(e) => set("message", e.target.value)}
          placeholder="A visitor from {{country}} completed {{goal}} via {{referrer}}."
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {editing ? "Save alert" : "Create alert"}
        </Button>
        <Button variant="secondary" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Alerts: rules, delivery channels and history (DataFast alerts + DataGoat channels). */
export default function AlertsPage() {
  const siteId = useSiteId();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Alert | "new" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const alerts = useQuery({
    queryKey: ["alerts", siteId],
    queryFn: () => apiGet<Alert[]>(`/api/v1/admin/websites/${siteId}/alerts`),
  });
  const channels = useQuery({
    queryKey: ["alerts", siteId, "channels"],
    queryFn: () => apiGet<AlertChannels>(`/api/v1/admin/websites/${siteId}/alerts/channels`),
  });
  const history = useQuery({
    queryKey: ["alerts", siteId, "history"],
    queryFn: async () => {
      const res = await api.get<AlertHistoryEntry[]>(
        `/api/v1/admin/websites/${siteId}/alerts/history`,
        { limit: 50 },
      );
      return {
        rows: res.data,
        counts: res.raw.counts as { sent: number; failed: number; total: number } | undefined,
      };
    },
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["alerts", siteId] });
  const toggle = useMutation({
    mutationFn: (a: Alert) =>
      api.put(`/api/v1/admin/websites/${siteId}/alerts/${a.id}`, { isEnabled: !a.isEnabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (a: Alert) => api.delete(`/api/v1/admin/websites/${siteId}/alerts/${a.id}`),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: (a: Alert) => api.post(`/api/v1/admin/websites/${siteId}/alerts/${a.id}/test`),
    onSuccess: () => {
      setNotice({ tone: "success", text: "Test notification sent." });
      refresh();
    },
    onError: (err) => {
      setNotice({ tone: "error", text: err.message });
      refresh();
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alerts"
        description="Get an email, Telegram message or webhook when a goal is completed, a sale comes in or traffic spikes, plus daily and weekly digests."
        actions={
          editing ? null : (
            <Button onClick={() => setEditing("new")} disabled={(alerts.data?.length ?? 0) >= 25}>
              New alert
            </Button>
          )
        }
      />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {secret ? (
        <Notice tone="success">
          Webhook signing secret (shown once): <code className="font-mono">{secret}</code>
        </Notice>
      ) : null}
      {channels.data && !channels.data.email.configured ? (
        <Notice>
          Email delivery is not configured on this server. Telegram and webhooks work without setup.
        </Notice>
      ) : null}
      {editing ? (
        <Card title={editing === "new" ? "New alert" : `Edit “${editing.name}”`}>
          <AlertForm
            siteId={siteId}
            channels={channels.data}
            editing={editing === "new" ? null : editing}
            onDone={(s) => {
              setEditing(null);
              if (s) setSecret(s);
            }}
          />
        </Card>
      ) : null}
      <Card title="Rules">
        {alerts.isPending ? (
          <Spinner />
        ) : alerts.error ? (
          <Notice tone="error">{alerts.error.message}</Notice>
        ) : (
          <Table
            caption="Alert rules"
            rows={alerts.data ?? []}
            rowKey={(a) => a.id}
            empty="No alerts yet. Create one to get notified about goals, sales and spikes."
            columns={[
              {
                key: "name",
                header: "Alert",
                render: (a) => (
                  <div>
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-muted">{triggerLabel(a)}</div>
                  </div>
                ),
              },
              {
                key: "dest",
                header: "Destination",
                render: (a) => (
                  <div>
                    <div className="capitalize">{a.destination.type}</div>
                    <div className="max-w-56 truncate text-xs text-muted">
                      {destinationLabel(a, channels.data)}
                    </div>
                  </div>
                ),
              },
              {
                key: "today",
                header: "Today",
                align: "right",
                render: (a) => fmtNumber(a.dailyCount),
              },
              {
                key: "total",
                header: "Total",
                align: "right",
                render: (a) => fmtNumber(a.triggerCount),
              },
              {
                key: "last",
                header: "Last sent",
                render: (a) => (
                  <div>
                    <div>{fmtDate(a.lastTriggeredAt, true)}</div>
                    {a.lastError ? (
                      <div className="max-w-56 truncate text-xs text-error-text">{a.lastError}</div>
                    ) : null}
                  </div>
                ),
              },
              {
                key: "actions",
                header: "Actions",
                render: (a) => (
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      aria-label={`${a.isEnabled ? "Pause" : "Enable"} ${a.name}`}
                      onClick={() => toggle.mutate(a)}
                    >
                      {a.isEnabled ? "Pause" : "Enable"}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Test ${a.name}`}
                      onClick={() => test.mutate(a)}
                      disabled={test.isPending}
                    >
                      Test
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Edit ${a.name}`}
                      onClick={() => setEditing(a)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Delete ${a.name}`}
                      onClick={() => {
                        if (window.confirm(`Delete the alert “${a.name}”?`)) remove.mutate(a);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>
      <Card title="History">
        {history.data?.counts ? (
          <p className="mb-2 text-sm text-muted">
            {fmtNumber(history.data.counts.sent)} sent · {fmtNumber(history.data.counts.failed)}{" "}
            failed
          </p>
        ) : null}
        <Table
          caption="Alert history"
          rows={history.data?.rows ?? []}
          rowKey={(h, i) => `${h.alertId}-${h.triggeredAt}-${i}`}
          empty="Nothing sent yet."
          columns={[
            { key: "at", header: "When", render: (h) => fmtDate(h.triggeredAt, true) },
            { key: "alert", header: "Alert", render: (h) => h.alertName },
            { key: "what", header: "Event", render: (h) => h.summary ?? h.goalName ?? "–" },
            {
              key: "channel",
              header: "Channel",
              render: (h) => <span className="capitalize">{h.channel ?? "email"}</span>,
            },
            {
              key: "status",
              header: "Status",
              render: (h) =>
                h.status === "sent" ? (
                  <span className="text-success-text">Sent</span>
                ) : (
                  <span className="text-error-text" title={h.error ?? undefined}>
                    Failed{h.error ? `: ${h.error}` : ""}
                  </span>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
