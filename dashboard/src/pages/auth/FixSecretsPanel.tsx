import { useState } from "react";
import { Button, Notice } from "../../components/ui";
import { CodeBlock, CopyField } from "../settings/lib/ui";

/** The three Worker secrets setup needs, with the random length each one gets. */
const SECRETS = {
  SETUP_TOKEN: { bytes: 24, purpose: "Opens the one-time setup link." },
  SESSION_SECRET: { bytes: 32, purpose: "Signs dashboard sign-in cookies." },
  ENCRYPTION_KEY: {
    bytes: 32,
    purpose: "Encrypts payment and integration credentials. Never change it once you connect one.",
  },
} as const;

type SecretName = keyof typeof SECRETS;

/** Random hex generated in the browser. It is never sent to the server. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Which secrets the server reported as wrong, from its `configErrors` messages. */
export function failingSecrets(errors: string[]): SecretName[] {
  const names = Object.keys(SECRETS) as SecretName[];
  return names.filter((name) => errors.some((e) => e.startsWith(name)));
}

/**
 * Shown by the setup page when the Worker's secrets are missing or still hold the example values
 * (the Deploy to Cloudflare form pre-fills them). Explains the fix in the Cloudflare dashboard and
 * with Wrangler, and offers fresh random values to paste.
 */
export function FixSecretsPanel({
  errors,
  onCheckAgain,
  checking,
}: {
  errors: string[];
  onCheckAgain: () => void;
  checking: boolean;
}) {
  const names = failingSecrets(errors);
  const [values] = useState(
    () =>
      Object.fromEntries(names.map((n) => [n, randomHex(SECRETS[n].bytes)])) as Record<
        SecretName,
        string
      >,
  );
  const host = window.location.host;
  const token = values.SETUP_TOKEN;

  return (
    <div className="space-y-5 text-sm">
      <Notice tone="error">
        <p className="font-medium">Your Worker's secrets need real values before setup.</p>
        <ul className="mt-1 list-disc pl-5">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Notice>

      <section className="space-y-2" aria-labelledby="fix-secrets-values">
        <h2 id="fix-secrets-values" className="font-semibold">
          1. Copy new values
        </h2>
        <p className="text-muted">
          Generated in your browser just now and never sent anywhere. Refreshing the page makes new
          ones.
        </p>
        {names.map((name) => (
          <CopyField
            key={name}
            label={name}
            visibleLabel
            value={values[name]}
            hint={SECRETS[name].purpose}
          />
        ))}
      </section>

      <section className="space-y-2" aria-labelledby="fix-secrets-dashboard">
        <h2 id="fix-secrets-dashboard" className="font-semibold">
          2. Save them in Cloudflare
        </h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Open the Cloudflare dashboard, then <b>Workers &amp; Pages</b>, then the Worker that
            serves <b>{host}</b>.
          </li>
          <li>
            Go to <b>Settings</b>, then <b>Variables and Secrets</b>.
          </li>
          <li>
            For each name above, choose <b>Edit</b> (or <b>Add</b> with type <b>Secret</b>), paste
            the new value and save. Cloudflare deploys the change in a few seconds.
          </li>
        </ol>
        <details className="rounded-md border border-line p-3">
          <summary className="cursor-pointer font-medium">Or use Wrangler from a terminal</summary>
          <p className="mt-2 text-muted">
            Run each command in a clone of your DataGoat repository and paste the value when asked.
          </p>
          <div className="mt-2">
            <CodeBlock
              label="Wrangler commands"
              code={names.map((n) => `npx wrangler secret put ${n}`).join("\n")}
            />
          </div>
        </details>
      </section>

      <section className="space-y-2" aria-labelledby="fix-secrets-continue">
        <h2 id="fix-secrets-continue" className="font-semibold">
          3. Continue setup
        </h2>
        {token ? (
          <>
            <p className="text-muted">
              Your setup link uses the new SETUP_TOKEN. Keep it private until your account exists.
            </p>
            <CopyField
              label="Setup link"
              visibleLabel
              value={`${window.location.origin}/setup?token=${token}`}
            />
          </>
        ) : null}
        <Button className="w-full" onClick={onCheckAgain} disabled={checking}>
          {checking ? "Checking…" : "I saved them, check again"}
        </Button>
      </section>
    </div>
  );
}
