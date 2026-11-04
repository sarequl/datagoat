/**
 * W7 end to end on the real Worker (`wrangler dev`): an MCP client's OAuth flow through the
 * dashboard consent page in a browser, MCP calls with the issued token, and the CLI against the
 * same server. Runs after worker.spec.ts has created the owner (it waits for setup).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);
const OWNER = { email: "owner@example.com", password: "an-e2e-password" };
const REDIRECT = "http://127.0.0.1:9/callback";

const b64url = (buf: Buffer) => buf.toString("base64url");

test("an MCP client connects with OAuth through the consent page, then the CLI works", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  // Wait for worker.spec.ts to finish first-run setup.
  await expect
    .poll(async () => (await (await request.get("/api/setup")).json()).data.needsSetup, {
      timeout: 60_000,
    })
    .toBe(false);
  const login = await page.request.post("/api/auth/login", { data: OWNER });
  expect(login.status()).toBe(200);

  const reg = await request.post("/oauth/register", {
    data: {
      client_name: "E2E Agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    },
  });
  expect(reg.status()).toBe(201);
  const clientId = (await reg.json()).client_id as string;

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  let redirected = "";
  await page.route(`${REDIRECT}**`, async (route) => {
    redirected = route.request().url();
    await route.fulfill({ status: 200, body: "ok" });
  });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "e2e-state",
    scope: "websites:read analytics:read",
    resource: `${baseURL}/mcp`,
  });
  await page.goto(`/oauth/authorize?${params}`);
  await expect(
    page.getByRole("heading", { name: "Allow E2E Agent to access DataGoat?" }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Read analytics/ })).toBeChecked();
  await page.getByRole("checkbox", { name: /Read settings/ }).check();
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect.poll(() => redirected).toContain("code=");
  const back = new URL(redirected);
  expect(back.searchParams.get("state")).toBe("e2e-state");
  expect(back.searchParams.get("iss")).toBe(baseURL);

  const token = await request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${baseURL}/mcp`,
    },
  });
  expect(token.status()).toBe(200);
  const { access_token: accessToken, scope } = await token.json();
  expect(scope).toBe("websites:read analytics:read settings:read");

  const mcp = (body: unknown) =>
    request.post("/mcp", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json, text/event-stream",
      },
      data: body,
    });
  const init = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  expect((await init.json()).result.serverInfo.name).toBe("datagoat");
  const sites = await mcp({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "websites_list", arguments: {} },
  });
  const result = (await sites.json()).result;
  expect(result.structuredContent.data[0]).toMatchObject({ domain: "example.com" });
  const unauth = await request.post("/mcp", { data: { jsonrpc: "2.0", id: 3, method: "ping" } });
  expect(unauth.status()).toBe(401);
  expect(unauth.headers()["www-authenticate"]).toContain("oauth-protected-resource/mcp");

  // The connection is listed for the user, and the CLI works with an account token.
  const connections = await page.request.get("/api/v1/admin/oauth/connections");
  expect((await connections.json()).data[0].client.name).toBe("E2E Agent");
  const created = await page.request.post("/api/v1/admin/access-tokens", {
    data: { name: "e2e cli", permissions: ["websites:read", "analytics:read"] },
    headers: { origin: baseURL ?? "" },
  });
  const dft = (await created.json()).data[0].key as string;
  if (!existsSync("cli/dist/datagoat.mjs")) await run("node", ["cli/build.mjs"]);
  const cli = await run("node", ["cli/bin/datagoat.mjs", "--json", "sites", "list"], {
    env: {
      ...process.env,
      DATAGOAT_URL: baseURL,
      DATAGOAT_TOKEN: dft,
      DATAGOAT_CONFIG: "/nonexistent/x.json",
    },
  });
  expect(JSON.parse(cli.stdout)[0]).toMatchObject({ domain: "example.com", role: "owner" });
});
