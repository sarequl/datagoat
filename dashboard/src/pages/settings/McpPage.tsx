/**
 * AI assistants (MCP): the server URL to paste into Claude, ChatGPT, Cursor and other MCP
 * clients, how to connect each one (OAuth sign-in or a token), and the apps already connected.
 * The server itself is src/mcp; docs/mcp.md has the full reference.
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AppIcon, type AppId } from "../../components/AppIcons";
import { Card } from "../../components/ui";
import { ConnectionsCard } from "../account/AccountPage";
import { useSiteId } from "./lib/hooks";
import { CodeBlock, CopyField, PageHeader } from "./lib/ui";

type Client = "claude-code" | "claude" | "chatgpt" | "cursor" | "codex";

const CLIENTS: ReadonlyArray<{ id: Client; label: string; app: AppId }> = [
  { id: "claude-code", label: "Claude Code", app: "claude" },
  { id: "claude", label: "Claude", app: "claude" },
  { id: "chatgpt", label: "ChatGPT", app: "chatgpt" },
  { id: "codex", label: "Codex", app: "codex" },
  { id: "cursor", label: "Cursor", app: "cursor" },
];

/** Steps and, where the client takes one, a command or config file for `url`. */
export function clientGuide(client: Client, url: string): { steps: string[]; code?: string } {
  switch (client) {
    case "claude-code":
      return {
        steps: [
          "Run this in a terminal.",
          "Then type /mcp in Claude Code, choose datagoat and sign in. Your browser opens DataGoat to approve access.",
        ],
        code: `claude mcp add --transport http datagoat ${url}`,
      };
    case "claude":
      return {
        steps: [
          "In Claude (desktop or claude.ai), open Settings, then Connectors, then Add custom connector.",
          `Name it DataGoat, paste ${url} as the URL and connect.`,
          "Approve access on the DataGoat page that opens.",
        ],
      };
    case "chatgpt":
      return {
        steps: [
          "In ChatGPT, turn on developer mode: Settings, then Apps & Connectors, then Advanced.",
          `Create a connector with the URL ${url} and choose OAuth as the authentication.`,
          "Approve access on the DataGoat page that opens. Results show as interactive charts.",
        ],
      };
    case "cursor":
      return {
        steps: [
          "Add this to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).",
          "Cursor then offers to sign in; approve access on the DataGoat page that opens.",
        ],
        code: JSON.stringify({ mcpServers: { datagoat: { url } } }, null, 2),
      };
    case "codex":
      return {
        steps: [
          "Create an account token on the API keys page, store it in DATAGOAT_TOKEN, then run this.",
        ],
        code: `codex mcp add datagoat --url ${url} --bearer-token-env-var DATAGOAT_TOKEN`,
      };
  }
}

export default function McpPage() {
  const siteId = useSiteId();
  const url = `${window.location.origin}/mcp`;
  const [client, setClient] = useState<Client>("claude-code");
  const guide = clientGuide(client, url);
  return (
    <div className="space-y-5">
      <PageHeader
        title="AI assistants (MCP)"
        description="Ask Claude, ChatGPT, Cursor and other AI assistants about your traffic and revenue. They connect to DataGoat's MCP server and only see the websites and permissions you approve."
      />
      <Card title="Server URL">
        <CopyField
          label="MCP server URL"
          value={url}
          hint="Paste this into your AI assistant. It signs in with OAuth, so you never share a password or key."
        />
      </Card>
      <Card title="Connect your assistant">
        <div role="tablist" aria-label="AI assistant" className="mb-4 flex flex-wrap gap-1">
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={client === c.id}
              onClick={() => setClient(c.id)}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm ${
                client === c.id
                  ? "bg-surface-2 font-medium text-text shadow-pill"
                  : "text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              <AppIcon app={c.app} />
              {c.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          aria-label={CLIENTS.find((c) => c.id === client)?.label}
          className="space-y-3"
        >
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {guide.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {guide.code ? <CodeBlock label={`${client} setup`} code={guide.code} /> : null}
        </div>
        <p className="mt-4 text-sm text-muted">
          Prefer a token, or a client without sign-in? Create an account token (dgt_) on the{" "}
          <Link to="/app/$siteId/keys" params={{ siteId }} className="text-primary-text underline">
            API keys
          </Link>{" "}
          page and send it as <code>Authorization: Bearer …</code>. Try asking:{" "}
          <em>“Show visitors and revenue for the last 7 days.”</em>
        </p>
      </Card>
      <ConnectionsCard />
    </div>
  );
}
