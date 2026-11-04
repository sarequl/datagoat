import { type ReactNode, useMemo, useState } from "react";
import type { Website, WebsiteUpdate } from "../../../../shared/api-types";
import { Button, Card, Notice } from "../../components/ui";
import {
  countryFlag,
  countryName,
  countryOptions,
  isIpOrCidr,
  isValidHostname,
  normaliseHostname,
} from "./lib/format";
import { useAccess, useSiteId, useUpdateWebsite, useWebsite } from "./lib/hooks";
import { IGNORE_OFF, IGNORE_ON } from "./lib/snippets";
import {
  CodeBlock,
  ListEditor,
  QueryState,
  ReadOnlyNotice,
  SaveRow,
  Select,
  SettingsLayout,
} from "./lib/ui";

type ListField =
  | "excludedIps"
  | "excludedPaths"
  | "excludedCountries"
  | "excludedHostnames"
  | "excludedUserAgents";

/**
 * Website settings > Exclusions: IPs and CIDR ranges, paths with wildcards, countries, hostnames,
 * user agents, and excluding your own browser. Excluded hits are never stored or counted.
 */
export default function ExclusionsSettingsPage() {
  const siteId = useSiteId();
  const website = useWebsite(siteId);
  const access = useAccess(siteId);
  const disabled = !access.canEditSettings;
  const w = website.data;
  return (
    <SettingsLayout siteId={siteId} domain={w?.domain}>
      {w ? (
        <div className="space-y-5">
          {disabled ? <ReadOnlyNotice role={access.role} action="change exclusions" /> : null}
          <Notice>
            Excluded visits are dropped before they are stored, so they also save Cloudflare quota.
            Never exclude pages where conversions happen, such as checkout or thank-you pages, or
            revenue can no longer be attributed.
          </Notice>
          <ListCard
            website={w}
            field="excludedIps"
            title="IP addresses"
            description="Single addresses or CIDR ranges, IPv4 or IPv6. Only the visitor's IP is checked; DataGoat never stores it."
            placeholder="203.0.113.7 or 10.0.0.0/8"
            normalise={(v) => v.trim()}
            validate={(v) => (isIpOrCidr(v) ? null : `${v} is not an IP address or CIDR range.`)}
            disabled={disabled}
            max={200}
            extra={(add) => <MyIpButton onIp={add} disabled={disabled} />}
          />
          <ListCard
            website={w}
            field="excludedPaths"
            title="Pages"
            description={
              <>
                <code>/admin</code> excludes only that page; <code>/admin/*</code> excludes every
                page under /admin but not /admin itself.
              </>
            }
            placeholder="/admin/*"
            normalise={(v) => v.trim()}
            validate={(v) =>
              !v.startsWith("/")
                ? "Paths start with /."
                : v.length > 300
                  ? "Paths are at most 300 characters."
                  : null
            }
            disabled={disabled}
            max={100}
          />
          <CountriesCard website={w} disabled={disabled} />
          <ListCard
            website={w}
            field="excludedHostnames"
            title="Hostnames"
            description="Exact hostnames only: staging.example.com excludes that host, example.com does not exclude its subdomains."
            placeholder="staging.example.com"
            normalise={normaliseHostname}
            validate={(v) => (isValidHostname(v) ? null : `${v} is not a valid hostname.`)}
            disabled={disabled}
            max={100}
          />
          {"excludedUserAgents" in w ? (
            <ListCard
              website={w}
              field="excludedUserAgents"
              title="User agents"
              description="Visits whose User-Agent contains any of these texts (case-insensitive), such as an uptime monitor or your own scraper."
              placeholder="UptimeRobot"
              normalise={(v) => v.trim()}
              validate={(v) => (v.length < 3 || v.length > 200 ? "Use 3 to 200 characters." : null)}
              disabled={disabled}
              max={50}
              splitOnSpace={false}
            />
          ) : null}
          <OwnVisitsCard domain={w.domain} />
        </div>
      ) : (
        <QueryState query={website} />
      )}
    </SettingsLayout>
  );
}

function ListCard({
  website,
  field,
  title,
  description,
  placeholder,
  normalise,
  validate,
  disabled,
  max,
  extra,
  splitOnSpace = true,
}: {
  website: Website;
  field: ListField;
  title: string;
  description: ReactNode;
  placeholder: string;
  normalise: (v: string) => string;
  validate: (v: string) => string | null;
  disabled: boolean;
  max: number;
  extra?: (add: (value: string) => void) => ReactNode;
  splitOnSpace?: boolean;
}) {
  const update = useUpdateWebsite(website._id);
  const original = website[field] ?? [];
  const [items, setItems] = useState<string[]>(original);
  const dirty = JSON.stringify(items) !== JSON.stringify(original);
  return (
    <Card title={title}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ [field]: items } as WebsiteUpdate, {
            onSuccess: (w) => setItems(w[field] ?? []),
          });
        }}
      >
        <p className="text-sm text-muted">{description}</p>
        <ListEditor
          label={`Excluded ${title.toLowerCase()}`}
          items={items}
          onChange={setItems}
          placeholder={placeholder}
          normalise={normalise}
          validate={validate}
          disabled={disabled}
          max={max}
          splitOnSpace={splitOnSpace}
        />
        {extra && !disabled
          ? extra((value) => setItems((list) => (list.includes(value) ? list : [...list, value])))
          : null}
        <SaveRow
          dirty={dirty}
          pending={update.isPending}
          error={update.error}
          saved={update.isSuccess}
          disabled={disabled}
        />
      </form>
    </Card>
  );
}

/** Reads the caller's public IP from Cloudflare's /cdn-cgi/trace on this same origin. */
async function detectMyIp(): Promise<string> {
  const res = await fetch("/cdn-cgi/trace", { credentials: "omit" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const line = (await res.text()).split("\n").find((l) => l.startsWith("ip="));
  const ip = line?.slice(3).trim();
  if (!ip || !isIpOrCidr(ip)) throw new Error("no ip in response");
  return ip;
}

function MyIpButton({ onIp, disabled }: { onIp: (ip: string) => void; disabled: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [ip, setIp] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Button
        variant="secondary"
        disabled={disabled || state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            const found = await detectMyIp();
            setIp(found);
            onIp(found);
            setState("idle");
          } catch {
            setState("error");
          }
        }}
      >
        {state === "busy" ? "Detecting…" : "Add my current IP"}
      </Button>
      <span aria-live="polite" className="text-xs text-muted">
        {state === "error"
          ? "Could not detect your IP from here. Search for “what is my IP” and add it by hand."
          : ip
            ? `Added ${ip}. Save to apply.`
            : null}
      </span>
    </div>
  );
}

function CountriesCard({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  const [items, setItems] = useState(website.excludedCountries);
  const [pick, setPick] = useState("");
  const options = useMemo(() => countryOptions(), []);
  const dirty = JSON.stringify(items) !== JSON.stringify(website.excludedCountries);
  return (
    <Card title="Countries">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(
            { excludedCountries: items },
            { onSuccess: (w) => setItems(w.excludedCountries) },
          );
        }}
      >
        <p className="text-sm text-muted">
          Drop every event from these countries, for example bot-heavy regions you do not serve.
        </p>
        {!disabled ? (
          <div className="flex gap-2">
            <Select
              aria-label="Country to exclude"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">Choose a country…</option>
              {options
                .filter((c) => !items.includes(c.code))
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
            </Select>
            <Button
              variant="secondary"
              disabled={!pick}
              onClick={() => {
                if (pick) setItems([...items, pick]);
                setPick("");
              }}
            >
              Add
            </Button>
          </div>
        ) : null}
        <ListEditor
          label="Excluded countries"
          items={items}
          onChange={setItems}
          disabled={disabled}
          readOnlyInput
          renderItem={(code) => `${countryFlag(code)} ${countryName(code)}`.trim()}
        />
        <SaveRow
          dirty={dirty}
          pending={update.isPending}
          error={update.error}
          saved={update.isSuccess}
          disabled={disabled}
        />
      </form>
    </Card>
  );
}

function OwnVisitsCard({ domain }: { domain: string }) {
  return (
    <Card title="Exclude your own visits">
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          To stop counting one browser, open {domain} in it, open the developer console (F12, or
          Option+Command+I in Safari) and run:
        </p>
        <CodeBlock code={IGNORE_ON} label="ignore command" />
        <p className="text-muted">
          Repeat on each subdomain and browser you test with. To count your visits again, run:
        </p>
        <CodeBlock code={IGNORE_OFF} label="re-enable command" />
        <p className="text-xs text-muted">
          For a whole office or VPN, exclude its IP addresses above instead.
        </p>
      </div>
    </Card>
  );
}
