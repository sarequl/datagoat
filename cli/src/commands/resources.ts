/** goals, funnels, alerts, notes, payments, identify. */
import type { CreatePaymentRequest, FunnelStep } from "../../../shared/api-types";
import { type Command, type Ctx, UsageError } from "../context";
import { ANALYTICS_FLAGS, filterParams, RANGE_FLAGS, rangeParams } from "../segment";

function parseJson<T>(flag: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new UsageError(`--${flag} must be valid JSON`);
  }
}

function keyValues(values: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new UsageError(`--${flag} expects key=value, got "${raw}"`);
    out[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---------------------------------------------------------------- goals

const goalsCommand: Command = {
  name: "goals",
  summary: "Tracked goals and their display customizations",
  sub: [
    {
      name: "list",
      summary: "Tracked goals with completions and saved customizations",
      run: async (ctx) => ctx.print(await ctx.client().trackedGoals(await ctx.site())),
    },
    {
      name: "customizations",
      summary: "Saved display names, colours and descriptions",
      flags: { "goal-name": { type: "string", value: "<goal>", description: "Only this goal" } },
      run: async (ctx) => {
        const res = await ctx
          .client()
          .goalCustomizations(await ctx.site(), ctx.flags.string("goal-name"));
        ctx.print(res.data);
      },
    },
    {
      name: "colors",
      summary: "Colours allowed for goal customizations",
      run: async (ctx) => {
        const res = await ctx.client().goalCustomizations(await ctx.site());
        ctx.print(res.colors ?? []);
      },
    },
    {
      name: "customize",
      summary: "Set a goal's display name, colour, description or hidden flag",
      usage: "<goal> [--display-name <text>] [--color <hex>] [--description <text>] [--hidden]",
      flags: {
        "display-name": { type: "string", value: "<text>", description: "Display name (≤80)" },
        color: { type: "string", value: "<hex>", description: "Colour from `goals colors`" },
        description: { type: "string", value: "<text>", description: "Description (≤300)" },
        hidden: { type: "boolean", description: "Hide the goal (use --no-hidden to show)" },
        "clear-display-name": { type: "boolean", description: "Remove the display name" },
        "clear-color": { type: "boolean", description: "Remove the colour" },
        "clear-description": { type: "boolean", description: "Remove the description" },
      },
      run: async (ctx) => {
        const site = await ctx.site();
        const goalName = await ctx.arg(0, "<goal>", "Goal name");
        const f = ctx.flags;
        const body = compact({
          goalName,
          displayName: f.bool("clear-display-name") ? null : f.string("display-name"),
          color: f.bool("clear-color") ? null : f.string("color"),
          description: f.bool("clear-description") ? null : f.string("description"),
          hidden: f.bool("hidden"),
        });
        if (Object.keys(body).length === 1) throw new UsageError("Nothing to change");
        ctx.print(await ctx.client().customizeGoal(site, body));
      },
    },
    {
      name: "reset",
      summary: "Remove a goal's customization (events are kept)",
      usage: "<goal>",
      run: async (ctx) => {
        const site = await ctx.site();
        const goal = await ctx.arg(0, "<goal>", "Goal name");
        await ctx.confirm(`Reset the display customization of ${goal}?`);
        await ctx.client().resetGoal(site, goal);
        ctx.done(`Reset ${goal}.`);
      },
    },
    {
      name: "track",
      summary: "Record a goal for a visitor from the server side",
      usage: "--visitor <id> --name <goal> [--meta key=value]",
      flags: {
        visitor: { type: "string", value: "<id>", description: "datafast_visitor_id" },
        name: { type: "string", value: "<name>", description: "Goal name" },
        description: { type: "string", value: "<text>", description: "Description" },
        meta: { type: "multi", value: "<key=value>", description: "Goal parameter, repeatable" },
      },
      run: async (ctx) => {
        const site = await ctx.siteQuery();
        const visitor = await ctx.need("visitor", "Visitor id");
        const name = await ctx.need("name", "Goal name");
        const meta = keyValues(ctx.flags.list("meta"), "meta");
        const res = await ctx.client().trackGoal(
          site,
          compact({
            datafast_visitor_id: visitor,
            name,
            description: ctx.flags.string("description"),
            metadata: Object.keys(meta).length ? meta : undefined,
          }),
        );
        ctx.print(res);
      },
    },
    {
      name: "delete-events",
      summary: "Delete recorded goal events (by visitor, goal and/or date range)",
      usage: "[--visitor <id>] [--name <goal>] [--from <date> --to <date>]",
      flags: {
        visitor: { type: "string", value: "<id>", description: "Only this visitor" },
        name: { type: "string", value: "<name>", description: "Only this goal" },
        ...RANGE_FLAGS,
      },
      run: async (ctx) => {
        const site = await ctx.siteQuery();
        const query = compact({
          websiteId: site,
          datafast_visitor_id: ctx.flags.string("visitor"),
          name: ctx.flags.string("name"),
          ...(await rangeParams(ctx, site)),
        }) as Record<string, string>;
        await ctx.confirm("Permanently delete the matching goal events?");
        ctx.print(await ctx.client().deleteGoalEvents(query));
      },
    },
  ],
};

// ---------------------------------------------------------------- funnels

async function buildSteps(ctx: Ctx): Promise<FunnelStep[]> {
  const raw = ctx.flags.string("steps");
  if (raw) return parseJson<FunnelStep[]>("steps", raw);
  const prompt = ctx.io.prompt;
  if (!prompt) throw new UsageError("--steps '<JSON array>' is required");
  const steps: FunnelStep[] = [];
  for (let n = 1; n <= 8; n++) {
    const type = (await prompt(`Step ${n} type (pageview/goal, empty to finish): `)).trim();
    if (!type) break;
    if (type !== "pageview" && type !== "goal")
      throw new UsageError("Type must be pageview or goal");
    const target = (await prompt(type === "pageview" ? "  Page path: " : "  Goal name: ")).trim();
    const name = (await prompt(`  Step name [${target}]: `)).trim() || target;
    steps.push(
      type === "pageview" ? { name, type, url: target } : { name, type, goalName: target },
    );
  }
  return steps;
}

const funnelsCommand: Command = {
  name: "funnels",
  summary: "Conversion funnels",
  sub: [
    {
      name: "list",
      summary: "Active funnels",
      run: async (ctx) =>
        ctx.print(await ctx.client().funnels(await ctx.site()), [
          { key: "id" },
          { key: "name" },
          {
            key: "steps",
            format: (v) => (v as Array<{ name: string }>).map((s) => s.name).join(" → "),
          },
        ]),
    },
    {
      name: "view",
      summary: "Funnel report: visitors, conversion and drop-off per step",
      usage: "<funnelId> [--period …] [filters]",
      flags: ANALYTICS_FLAGS,
      run: async (ctx) => {
        const site = await ctx.siteQuery();
        const id = await ctx.arg(0, "<funnelId>", "Funnel id");
        const [result] = await ctx
          .client()
          .funnel(site, id, { ...(await rangeParams(ctx, site)), ...filterParams(ctx) });
        if (ctx.json) return ctx.out(`${JSON.stringify(result)}\n`);
        const r = result as unknown as { name?: string; steps?: Array<Record<string, unknown>> };
        if (r?.name) ctx.out(`${r.name}\n`);
        ctx.print(r?.steps ?? result);
      },
    },
    {
      name: "create",
      summary: "Create a funnel of 2–8 pageview/goal steps",
      usage: `--name <name> --steps '[{"name":"Pricing","type":"pageview","url":"/pricing"},…]'`,
      flags: {
        name: { type: "string", value: "<name>", description: "Funnel name" },
        steps: { type: "string", value: "<json>", description: "Steps as a JSON array" },
      },
      run: async (ctx) => {
        const site = await ctx.site();
        const name = await ctx.need("name", "Funnel name");
        const steps = await buildSteps(ctx);
        ctx.print(await ctx.client().createFunnel(site, { name, steps }));
      },
    },
    {
      name: "update",
      summary: "Rename, replace steps, or enable/disable",
      usage: "<funnelId> [--name <name>] [--steps <json>] [--enable|--disable]",
      flags: {
        name: { type: "string", value: "<name>", description: "New name" },
        steps: { type: "string", value: "<json>", description: "Steps as a JSON array" },
        enable: { type: "boolean", description: "Make the funnel active" },
        disable: { type: "boolean", description: "Make the funnel inactive" },
      },
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<funnelId>", "Funnel id");
        const steps = ctx.flags.string("steps");
        const body = compact({
          name: ctx.flags.string("name"),
          steps: steps ? parseJson("steps", steps) : undefined,
          isActive: ctx.flags.bool("enable") ? true : ctx.flags.bool("disable") ? false : undefined,
        });
        if (Object.keys(body).length === 0) throw new UsageError("Nothing to update");
        ctx.print(await ctx.client().updateFunnel(site, id, body));
      },
    },
    {
      name: "delete",
      summary: "Delete a funnel (it becomes inactive)",
      usage: "<funnelId>",
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<funnelId>", "Funnel id");
        await ctx.confirm(`Delete funnel ${id}?`);
        await ctx.client().deleteFunnel(site, id);
        ctx.done(`Deleted funnel ${id}.`);
      },
    },
  ],
};

// ---------------------------------------------------------------- alerts

const ALERT_FLAGS = {
  name: { type: "string", value: "<name>", description: "Alert name" },
  goal: { type: "multi", value: "<value>", description: "Fire when this goal completes" },
  trigger: {
    type: "string",
    value: "<json>",
    description: 'Other trigger as JSON, e.g. {"type":"new_sale"}',
  },
  message: { type: "string", value: "<text>", description: "Message (10–2000 chars)" },
  subject: { type: "string", value: "<text>", description: "Email subject" },
  email: { type: "string", value: "<email>", description: "Send to this email" },
  "telegram-chat": { type: "string", value: "<id>", description: "Send to this Telegram chat id" },
  "telegram-token": { type: "string", value: "<token>", description: "Telegram bot token" },
  enabled: { type: "boolean", description: "Enable the alert" },
  disabled: { type: "boolean", description: "Disable the alert" },
} as const;

function alertBody(ctx: Ctx, creating: boolean): Record<string, unknown> {
  const f = ctx.flags;
  const goal = f.list("goal")[0];
  const triggerJson = f.string("trigger");
  const trigger = goal
    ? { goalName: goal }
    : triggerJson
      ? parseJson("trigger", triggerJson)
      : undefined;
  const message =
    f.string("message") ?? (creating && goal ? `Goal "${goal}" was just completed.` : undefined);
  const template = message ? compact({ message, subject: f.string("subject") }) : undefined;
  const chat = f.string("telegram-chat");
  const email = f.string("email");
  const destination = chat
    ? compact({ type: "telegram", chatId: chat, botToken: f.string("telegram-token") })
    : email
      ? { type: "email", email }
      : undefined;
  return compact({
    name: f.string("name"),
    trigger,
    template,
    destination,
    isEnabled: f.bool("enabled") ? true : f.bool("disabled") ? false : undefined,
  });
}

const alertsCommand: Command = {
  name: "alerts",
  summary: "Goal, sale and traffic alerts",
  sub: [
    {
      name: "list",
      summary: "Configured alerts",
      run: async (ctx) =>
        ctx.print(await ctx.client().alerts(await ctx.site()), [
          { key: "id" },
          { key: "name" },
          { key: "trigger" },
          { key: "isEnabled", label: "enabled" },
        ]),
    },
    {
      name: "get",
      summary: "One alert",
      usage: "<alertId>",
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<alertId>", "Alert id");
        const alert = (await ctx.client().alerts(site)).find((a) => a.id === id);
        if (!alert) throw new UsageError(`Alert ${id} not found`);
        ctx.print(alert);
      },
    },
    {
      name: "create",
      summary: "Create an alert",
      usage: "--name <name> --goal <goal> [--message <text>] [--email <to>] [--disabled]",
      flags: ALERT_FLAGS,
      run: async (ctx) => {
        const site = await ctx.site();
        const name = await ctx.need("name", "Alert name");
        const body: Record<string, unknown> = { ...alertBody(ctx, true), name };
        if (!body.trigger) {
          const goal = ctx.io.prompt
            ? (await ctx.io.prompt("Goal that fires the alert: ")).trim()
            : "";
          if (!goal) throw new UsageError("--goal <goal> (or --trigger <json>) is required");
          body.trigger = { goalName: goal };
          body.template ??= { message: `Goal "${goal}" was just completed.` };
        }
        ctx.print(await ctx.client().createAlert(site, body));
      },
    },
    {
      name: "update",
      summary: "Change name, goal, message, destination or enabled state",
      usage: "<alertId> [--name …] [--goal …] [--enabled|--disabled]",
      flags: ALERT_FLAGS,
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<alertId>", "Alert id");
        const body = alertBody(ctx, false);
        if (Object.keys(body).length === 0) throw new UsageError("Nothing to update");
        ctx.print(await ctx.client().updateAlert(site, id, body));
      },
    },
    {
      name: "delete",
      summary: "Delete an alert",
      usage: "<alertId>",
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<alertId>", "Alert id");
        await ctx.confirm(`Delete alert ${id}?`);
        await ctx.client().deleteAlert(site, id);
        ctx.done(`Deleted alert ${id}.`);
      },
    },
    {
      name: "history",
      summary: "Recent deliveries (sent / failed)",
      flags: {
        alert: { type: "string", value: "<id>", description: "Only this alert" },
        limit: { type: "string", value: "<n>", description: "Max rows (≤100)" },
      },
      run: async (ctx) => {
        const res = await ctx.client().alertHistory(await ctx.site(), {
          alertId: ctx.flags.string("alert"),
          limit: ctx.flags.int("limit", { min: 1, max: 100 }),
        });
        if (ctx.json) return ctx.out(`${JSON.stringify(res.data)}\n`);
        ctx.print(res.data);
        const counts = (res as { counts?: Record<string, number> }).counts;
        if (counts)
          ctx.out(
            `sent ${counts.sent ?? 0}, failed ${counts.failed ?? 0}, total ${counts.total ?? 0}\n`,
          );
      },
    },
    {
      name: "test",
      summary: "Send a test notification",
      usage: "<alertId>",
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<alertId>", "Alert id");
        ctx.print(await ctx.client().testAlert(site, id));
      },
    },
  ],
};

// ---------------------------------------------------------------- notes

const notesCommand: Command = {
  name: "notes",
  summary: "Manual chart notes",
  sub: [
    {
      name: "list",
      summary: "Notes (default: last 30 days)",
      flags: {
        ...RANGE_FLAGS,
        search: { type: "string", value: "<text>", description: "Search the text" },
        limit: { type: "string", value: "<n>", description: "Max rows" },
      },
      run: async (ctx) => {
        const site = await ctx.site();
        const res = await ctx.client().notes(site, {
          ...(await rangeParams(ctx, site)),
          q: ctx.flags.string("search"),
          limit: ctx.flags.int("limit", { min: 1, max: 1000 }),
        });
        if (ctx.json) return ctx.out(`${JSON.stringify(res.data)}\n`);
        ctx.print(res.data, [{ key: "id" }, { key: "timestamp" }, { key: "text" }]);
      },
    },
    {
      name: "create",
      aliases: ["add"],
      summary: "Add a note",
      usage: '--text "Launched v2" [--at <ISO time or YYYY-MM-DD>] [--key <idempotency key>]',
      flags: {
        text: { type: "string", value: "<text>", description: "Note text (≤500)" },
        at: { type: "string", value: "<time>", description: "When (default: now)" },
        key: { type: "string", value: "<key>", description: "Idempotency key for safe retries" },
      },
      run: async (ctx) => {
        const site = await ctx.site();
        const text = await ctx.need("text", "Note");
        const timestamp = ctx.flags.string("at") ?? new Date(ctx.io.now()).toISOString();
        ctx.print(
          await ctx
            .client()
            .createNote(
              site,
              compact({ text, timestamp, idempotencyKey: ctx.flags.string("key") }),
            ),
        );
      },
    },
    {
      name: "update",
      summary: "Edit a note",
      usage: "<noteId> [--text …] [--at …]",
      flags: {
        text: { type: "string", value: "<text>", description: "New text" },
        at: { type: "string", value: "<time>", description: "New timestamp" },
      },
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<noteId>", "Note id");
        const body = compact({ text: ctx.flags.string("text"), timestamp: ctx.flags.string("at") });
        if (Object.keys(body).length === 0) throw new UsageError("Nothing to update");
        ctx.print(await ctx.client().updateNote(site, id, body));
      },
    },
    {
      name: "delete",
      summary: "Delete a note",
      usage: "<noteId>",
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<noteId>", "Note id");
        await ctx.confirm(`Delete note ${id}?`);
        await ctx.client().deleteNote(site, id);
        ctx.done(`Deleted note ${id}.`);
      },
    },
  ],
};

// ---------------------------------------------------------------- payments

const paymentsCommand: Command = {
  name: "payments",
  aliases: ["sales"],
  summary: "Payments: list, record (Payments API), delete",
  sub: [
    {
      name: "list",
      summary: "Payments in a range",
      flags: {
        ...RANGE_FLAGS,
        limit: { type: "string", value: "<n>", description: "Max rows" },
        offset: { type: "string", value: "<n>", description: "Rows to skip" },
        attributed: { type: "string", value: "<true|false>", description: "Only (un)attributed" },
        kind: {
          type: "string",
          value: "<kind>",
          description: "payment, renewal, refund, free_trial",
        },
      },
      run: async (ctx) => {
        const site = await ctx.siteQuery();
        const res = await ctx.client().payments(site, {
          ...(await rangeParams(ctx, site)),
          ...filterParams(ctx),
          limit: ctx.flags.int("limit", { min: 1, max: 1000 }),
          offset: ctx.flags.int("offset", { min: 0 }),
          attributed: ctx.flags.string("attributed"),
          kind: ctx.flags.string("kind"),
        });
        if (ctx.json) return ctx.out(`${JSON.stringify(res.data)}\n`);
        ctx.print(res.data);
      },
    },
    {
      name: "create",
      summary: "Record a payment (idempotent on --transaction-id)",
      usage: "--amount 49 --currency USD --transaction-id <id> [--visitor <id>] [--email …]",
      flags: {
        amount: {
          type: "string",
          value: "<amount>",
          description: "Amount in major units, e.g. 49.99",
        },
        currency: { type: "string", value: "<ISO>", description: "Currency, e.g. USD" },
        "transaction-id": { type: "string", value: "<id>", description: "Unique transaction id" },
        visitor: { type: "string", value: "<id>", description: "datafast_visitor_id" },
        email: { type: "string", value: "<email>", description: "Customer email" },
        name: { type: "string", value: "<name>", description: "Customer name" },
        "customer-id": { type: "string", value: "<id>", description: "Your customer id" },
        renewal: { type: "boolean", description: "A subscription renewal" },
        refunded: { type: "boolean", description: "Refunded" },
        trial: { type: "boolean", description: "A free trial" },
        timestamp: { type: "string", value: "<time>", description: "When it happened (ISO)" },
      },
      run: async (ctx) => {
        const site = await ctx.siteQuery();
        const amount = Number(await ctx.need("amount", "Amount"));
        if (!Number.isFinite(amount)) throw new UsageError("--amount must be a number");
        const body = compact({
          amount,
          currency: await ctx.need("currency", "Currency"),
          transaction_id: await ctx.need("transaction-id", "Transaction id"),
          datafast_visitor_id: ctx.flags.string("visitor"),
          email: ctx.flags.string("email"),
          name: ctx.flags.string("name"),
          customer_id: ctx.flags.string("customer-id"),
          renewal: ctx.flags.bool("renewal"),
          refunded: ctx.flags.bool("refunded"),
          is_free_trial: ctx.flags.bool("trial"),
          timestamp: ctx.flags.string("timestamp"),
        }) as unknown as CreatePaymentRequest;
        ctx.print(await ctx.client().createPayment(site, body));
      },
    },
    {
      name: "delete",
      summary: "Delete payments by transaction id, visitor or date range",
      usage: "--transaction-id <id> | --visitor <id> | --from <date> --to <date>",
      flags: {
        "transaction-id": { type: "string", value: "<id>", description: "Transaction id" },
        visitor: { type: "string", value: "<id>", description: "datafast_visitor_id" },
        ...RANGE_FLAGS,
      },
      run: async (ctx) => {
        const site = await ctx.siteQuery();
        const query = compact({
          transaction_id: ctx.flags.string("transaction-id"),
          datafast_visitor_id: ctx.flags.string("visitor"),
          ...(await rangeParams(ctx, site)),
        }) as Record<string, string>;
        if (Object.keys(query).length === 0) {
          throw new UsageError("Pass --transaction-id, --visitor or --from/--to");
        }
        await ctx.confirm("Delete the matching payments?");
        ctx.print(await ctx.client().deletePayments(site, query));
      },
    },
  ],
};

// ---------------------------------------------------------------- identify

const identifyCommand: Command = {
  name: "identify",
  summary: "Link a visitor to your user id (and profile fields)",
  usage: "--visitor <id> --user-id <id> [--name …] [--image …] [--prop key=value]",
  flags: {
    visitor: { type: "string", value: "<id>", description: "datafast_visitor_id" },
    "user-id": { type: "string", value: "<id>", description: "Your user id" },
    name: { type: "string", value: "<name>", description: "Display name" },
    image: { type: "string", value: "<url>", description: "Avatar URL" },
    prop: { type: "multi", value: "<key=value>", description: "Extra profile field, repeatable" },
  },
  run: async (ctx) => {
    const site = await ctx.siteQuery();
    const body = compact({
      ...keyValues(ctx.flags.list("prop"), "prop"),
      datafast_visitor_id: await ctx.need("visitor", "Visitor id"),
      user_id: await ctx.need("user-id", "User id"),
      name: ctx.flags.string("name"),
      image: ctx.flags.string("image"),
    });
    ctx.print(await ctx.client().identify(site, body));
  },
};

export const resourceCommands: Command[] = [
  goalsCommand,
  funnelsCommand,
  alertsCommand,
  notesCommand,
  paymentsCommand,
  identifyCommand,
];
