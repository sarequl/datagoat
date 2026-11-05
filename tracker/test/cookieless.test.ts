/** script.cookieless.js: no cookies, tab-scoped ids, server-issued visitor id. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./harness";

afterEach(() => vi.restoreAllMocks());

const SERVER = {
  visitorId: "0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4b",
  sessionId: "s0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4c",
};

describe("cookieless build", () => {
  it("is the cookieless variant", () => {
    expect(__DG_COOKIELESS__).toBe(true);
    expect(__DG_HASH__).toBe(false);
  });

  it("never touches document.cookie", () => {
    const writes: string[] = [];
    const t = setup({
      response: SERVER,
      before: (w) => {
        Object.defineProperty(w.document, "cookie", {
          configurable: true,
          get: () => {
            writes.push("read");
            return "";
          },
          set: (v: string) => writes.push(v),
        });
      },
    });
    t.api("signup");
    t.api("consent", true);
    expect(writes).toEqual([]);
  });

  it("sends cookieless: true without first-seen and session number", () => {
    const t = setup({ response: SERVER });
    const body = t.last();
    expect(body).toMatchObject({ websiteId: "dfid_test", type: "pageview", cookieless: true });
    expect(body).not.toHaveProperty("visitorFirstSeenAt");
    expect(body).not.toHaveProperty("visitorSessionNumber");
    expect(body.sessionId).toMatch(/^s[0-9a-f-]{36}$/);
  });

  it("reads the server's visitor id from the response into sessionStorage and window.datafast", async () => {
    const t = setup({ response: SERVER });
    expect(t.sent[0]?.transport).toBe("fetch");
    await t.flush();
    expect(t.win.sessionStorage.getItem("datagoat_visitor_id")).toBe(SERVER.visitorId);
    expect(t.win.sessionStorage.getItem("datagoat_session_id")).toBe(SERVER.sessionId);
    expect((t.w.datafast as { visitorId?: string }).visitorId).toBe(SERVER.visitorId);
    expect((t.w.datagoat as { visitorId?: string }).visitorId).toBe(SERVER.visitorId);
    t.api("signup");
    expect(t.last()).toMatchObject({ visitorId: SERVER.visitorId, sessionId: SERVER.sessionId });
  });

  it("sends a random visitor id before the server has answered, like DataFast's cookieless script", () => {
    const t = setup({ response: {} });
    t.api("a");
    const [first, second] = t.bodies();
    expect(first?.visitorId).not.toBe(second?.visitorId);
    expect(first?.sessionId).toBe(second?.sessionId);
  });

  it("does not decorate cross-domain links", () => {
    const t = setup({
      html: `<a id="a" href="https://myapp.io/">App</a>`,
      attrs: { "data-allowed-hostnames": "myapp.io" },
    });
    const a = t.win.document.getElementById("a") as unknown as HTMLAnchorElement;
    a.dispatchEvent(new t.win.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
    expect(a.href).toBe("https://myapp.io/");
  });

  it("still tracks goals, outbound links and payment success pages", () => {
    const t = setup({
      url: "https://www.example.com/thanks?session_id=cs_test_1",
      html: `<button id="b" data-fast-goal="cta">Go</button><a id="x" href="https://x.com/">X</a>`,
      response: SERVER,
    });
    (t.win.document.getElementById("b") as unknown as HTMLElement).click();
    const x = t.win.document.getElementById("x") as unknown as HTMLElement;
    x.addEventListener("click", (e) => e.preventDefault());
    x.click();
    expect(t.types()).toEqual(["pageview", "payment", "custom", "external_link"]);
  });
});
