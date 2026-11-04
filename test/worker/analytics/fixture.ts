/**
 * A small, fully known dataset for analytics tests (website timezone UTC, March 2026):
 *
 * | visitor | session | start (UTC)      | n | source / campaign          | geo / system                         | pages                    | other                        |
 * |---------|---------|------------------|---|----------------------------|--------------------------------------|--------------------------|------------------------------|
 * | v1      | A       | 03-10 10:00 +5m  | 1 | Google (Organic Search)    | US/California/San Francisco, desktop, Chrome, Mac OS | / /pricing /signup | goal signup {plan: pro}; payment 49.99 (A) |
 * | v2      | B       | 03-10 11:00      | 1 | direct                     | FR, mobile, Mobile Safari, iOS       | /blog/x (bounce)         |                              |
 * | v2      | C       | 03-11 09:00 +2m  | 2 | X (Organic Social)         | FR, mobile, Mobile Safari, iOS       | /pricing                 | outbound click github.com    |
 * | v3      | D       | 03-11 12:00 +10m | 1 | utm newsletter/launch, ref=hn (Email) | DE, tablet, Firefox, Windows | / /pricing             | goal checkout_started {plan: free}; renewal 10.00 (D) |
 */
import { env } from "cloudflare:test";
import type { Site } from "../../../src/lib/sites";
import {
  addMember,
  type CreatedSession,
  createApiKey,
  createEvent,
  createPayment,
  createSession,
  createSite,
  createUser,
  type SiteOverrides,
} from "../../helpers/factories";

export const T = (iso: string) => Date.parse(iso);
export const V1 = "11111111-1111-4111-8111-111111111111";
export const V2 = "22222222-2222-4222-8222-222222222222";
export const V3 = "33333333-3333-4333-8333-333333333333";

export interface Fixture {
  site: Site;
  owner: { id: string };
  key: string;
  sessions: Record<"A" | "B" | "C" | "D", CreatedSession>;
}

export async function seedFixture(overrides: SiteOverrides = {}): Promise<Fixture> {
  const owner = await createUser();
  const site = await createSite(owner.id, { domain: "example.com", ...overrides });
  const key = (await createApiKey({ userId: owner.id, siteId: site.id })).secret;
  const A = await createSession({
    siteId: site.id,
    visitorId: V1,
    startedAt: T("2026-03-10T10:00:00Z"),
    durationMs: 300_000,
    pageviews: 3,
    interactions: 1,
    entryPath: "/",
    channel: "Organic Search",
    source: "Google",
    referrerDomain: "google.com",
    country: "US",
    region: "California",
    city: "San Francisco",
    device: "desktop",
    browser: "Chrome",
    os: "Mac OS",
  });
  const B = await createSession({
    siteId: site.id,
    visitorId: V2,
    startedAt: T("2026-03-10T11:00:00Z"),
    pageviews: 1,
    entryPath: "/blog/x",
    country: "FR",
    device: "mobile",
    browser: "Mobile Safari",
    os: "iOS",
  });
  const C = await createSession({
    siteId: site.id,
    visitorId: V2,
    startedAt: T("2026-03-11T09:00:00Z"),
    durationMs: 120_000,
    sessionNumber: 2,
    pageviews: 1,
    interactions: 1,
    entryPath: "/pricing",
    channel: "Organic Social",
    source: "X",
    referrerDomain: "t.co",
    country: "FR",
    device: "mobile",
    browser: "Mobile Safari",
    os: "iOS",
  });
  const D = await createSession({
    siteId: site.id,
    visitorId: V3,
    startedAt: T("2026-03-11T12:00:00Z"),
    durationMs: 600_000,
    pageviews: 2,
    interactions: 1,
    entryPath: "/",
    channel: "Email",
    country: "DE",
    device: "tablet",
    browser: "Firefox",
    os: "Windows",
    utm: { utm_source: "newsletter", utm_campaign: "launch" },
    ref: "hn",
  });
  const ev = (session: CreatedSession, at: string, path: string, extra: object = {}) =>
    createEvent({ siteId: site.id, session, ts: T(at), path, hostname: "example.com", ...extra });
  await ev(A, "2026-03-10T10:00:00Z", "/");
  await ev(A, "2026-03-10T10:02:00Z", "/pricing");
  await ev(A, "2026-03-10T10:04:00Z", "/signup");
  await ev(A, "2026-03-10T10:05:00Z", "/signup", {
    type: "custom",
    name: "signup",
    props: { plan: "pro" },
  });
  await ev(B, "2026-03-10T11:00:00Z", "/blog/x");
  await ev(C, "2026-03-11T09:00:00Z", "/pricing");
  await ev(C, "2026-03-11T09:02:00Z", "/pricing", {
    type: "external_link",
    props: { url: "https://github.com/x", text: "GitHub" },
  });
  await ev(D, "2026-03-11T12:00:00Z", "/");
  await ev(D, "2026-03-11T12:05:00Z", "/pricing");
  await ev(D, "2026-03-11T12:10:00Z", "/pricing", {
    type: "custom",
    name: "checkout_started",
    props: { plan: "free" },
  });
  await createPayment({
    siteId: site.id,
    amountMinor: 4999,
    occurredAt: T("2026-03-10T10:06:00Z"),
    visitorId: V1,
    firstSessionId: A.id,
  });
  await createPayment({
    siteId: site.id,
    amountMinor: 1000,
    kind: "renewal",
    occurredAt: T("2026-03-11T12:11:00Z"),
    visitorId: V3,
    firstSessionId: D.id,
  });
  return { site, owner, key, sessions: { A, B, C, D } };
}

export const RANGE = "startAt=2026-03-10&endAt=2026-03-11";

/** A viewer and a dft_ token with only `permissions` for permission tests. */
export async function limitedToken(site: Site, permissions: string[]): Promise<string> {
  const user = await createUser();
  await addMember(site.id, user.id, "member");
  return (
    await createApiKey({
      userId: user.id,
      permissions: permissions as never,
      websiteIds: [site.id],
    })
  ).secret;
}

export { env };
