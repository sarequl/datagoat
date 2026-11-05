// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  checkoutMetadata,
  createServerClient,
  DataGoatApiError,
  getSessionId,
  getVisitorId,
  lemonSqueezyCheckoutData,
  readCookie,
} from "../src/server";

const VID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const SID = "s0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const HEADER = `theme=dark; datafast_visitor_id=${VID}; datafast_session_id=${SID}`;

describe("reading the visitor on the server", () => {
  it("works with headers, requests, Next.js cookies(), Express and plain objects", () => {
    expect(getVisitorId(HEADER)).toBe(VID);
    expect(getVisitorId(new Headers({ cookie: HEADER }))).toBe(VID);
    expect(getVisitorId(new Request("https://x.test", { headers: { cookie: HEADER } }))).toBe(VID);
    const nextCookies = {
      get: (name: string) => (name === "datafast_visitor_id" ? { name, value: VID } : undefined),
    };
    expect(getVisitorId(nextCookies)).toBe(VID);
    const expressParsed = { headers: {}, cookies: { datafast_visitor_id: VID } };
    expect(getVisitorId(expressParsed)).toBe(VID);
    const expressRaw = { headers: { cookie: HEADER } };
    expect(getSessionId(expressRaw)).toBe(SID);
    const expressReq = { get: (h: string) => (h === "cookie" ? HEADER : undefined) };
    expect(getVisitorId(expressReq)).toBe(VID);
    expect(getVisitorId({ datafast_visitor_id: VID })).toBe(VID);
    expect(getVisitorId(undefined)).toBeNull();
    expect(readCookie("a=1; a=2", "a")).toBe("1");
    expect(readCookie("v=%7B%22x%22%7D", "v")).toBe('{"x"}');
  });

  it("returns checkout metadata only for valid ids", () => {
    // DataFast's cookies (HEADER) are read; the metadata uses DataGoat's names.
    expect(checkoutMetadata(HEADER)).toEqual({
      datagoat_visitor_id: VID,
      datagoat_session_id: SID,
    });
    expect(
      checkoutMetadata(
        `datagoat_visitor_id=${VID}; datafast_visitor_id=00000000-0000-4000-8000-000000000000`,
      ),
    ).toEqual({ datagoat_visitor_id: VID });
    expect(checkoutMetadata("datafast_visitor_id=evil'); DROP")).toEqual({});
    expect(checkoutMetadata(`datafast_session_id=${SID}`)).toEqual({});
    expect(lemonSqueezyCheckoutData(HEADER)).toEqual({
      custom: { datagoat_visitor_id: VID, datagoat_session_id: SID },
    });
  });
});

describe("createServerClient", () => {
  it("posts goals, identify and payments with the API key", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "success", data: [] })));
    const client = createServerClient({
      baseUrl: "https://a.example.com/",
      apiKey: "df_secret",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await client.goal(VID, "signup", { plan: "pro" });
    await client.identify(VID, "user_1", { name: "Ada" });
    await client.payment({
      amount: 29,
      currency: "USD",
      transaction_id: "tx_1",
      datafast_visitor_id: VID,
    });
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map((c) => c[0])).toEqual([
      "https://a.example.com/api/v1/goals",
      "https://a.example.com/api/v1/identify",
      "https://a.example.com/api/v1/payments",
    ]);
    expect(new Headers(calls[0]?.[1].headers).get("authorization")).toBe("Bearer df_secret");
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({
      datagoat_visitor_id: VID,
      name: "signup",
      metadata: { plan: "pro" },
    });
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({
      name: "Ada",
      datagoat_visitor_id: VID,
      user_id: "user_1",
    });
  });

  it("adds websiteId for dft_ tokens and throws DataGoatApiError with the server's message", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ status: "error", error: { code: 404, message: "Visitor not found" } }),
          {
            status: 404,
          },
        ),
    );
    const client = createServerClient({
      baseUrl: "https://a.example.com",
      apiKey: "dft_x",
      websiteId: "site1",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const err = await client.goal(VID, "signup").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataGoatApiError);
    expect((err as DataGoatApiError).message).toBe("Visitor not found");
    expect((err as DataGoatApiError).status).toBe(404);
    const url = (fetch.mock.calls as unknown as Array<[string]>)[0]?.[0];
    expect(url).toBe("https://a.example.com/api/v1/goals?websiteId=site1");
  });
});
