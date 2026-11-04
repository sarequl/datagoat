import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useMemo, useState } from "react";
import { useCreateWebsite } from "../../api/hooks";
import { Button, Card, Input, Notice } from "../../components/ui";
import {
  browserTimezone,
  currencyOptions,
  isValidHostname,
  normaliseHostname,
  timezoneOptions,
} from "../settings/lib/format";
import { Field, Select } from "../settings/lib/ui";

/**
 * Add a website (plan §12 step 1): domain, name, timezone and currency, then the installation
 * guide (settings/install) with the snippet, verification and revenue connection.
 */
export default function NewSitePage() {
  const navigate = useNavigate();
  const create = useCreateWebsite();
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [currency, setCurrency] = useState("USD");
  const [error, setError] = useState<string | null>(null);
  const timezones = useMemo(() => timezoneOptions(timezone), [timezone]);
  const currencies = useMemo(() => currencyOptions(), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const clean = normaliseHostname(domain);
    if (!isValidHostname(clean)) {
      setError("Enter a domain like example.com, without https:// or a path.");
      return;
    }
    setError(null);
    create.mutate(
      { domain: clean, name: name.trim() || null, timezone, currency },
      {
        onSuccess: (created) =>
          void navigate({
            to: "/app/$siteId/settings/install",
            params: { siteId: created.websiteId },
            search: { welcome: 1 } as never,
          }),
      },
    );
  };

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">Add a website</h1>
      <Card>
        <form className="space-y-4" onSubmit={submit} noValidate>
          {create.error ? <Notice tone="error">{create.error.message}</Notice> : null}
          <Field
            label="Domain"
            error={error}
            hint="Your root domain, e.g. example.com. Subdomains are tracked too."
          >
            <Input
              required
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value);
                setError(null);
              }}
              placeholder="example.com"
            />
          </Field>
          <Field label="Name (optional)">
            <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Timezone" hint="Days in reports start at midnight here.">
              <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Currency" hint="Revenue is reported in this currency.">
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Adding…" : "Add website"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
