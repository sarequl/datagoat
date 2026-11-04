import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { _resetForTests, type TrackerFunction } from "../src/index";
import { DataGoatScript, dataGoatRewrites, QUEUE_SNIPPET, withDataGoat } from "../src/next";
import { DataGoatProvider, useDataGoat, useGoalOnMount, useIdentify } from "../src/react";

type W = Window & { datafast?: TrackerFunction };
const w = () => window as W;

beforeEach(() => {
  _resetForTests();
  delete w().datafast;
  document.head.innerHTML = "";
});

function Page() {
  const dg = useDataGoat();
  useIdentify("user_9", { plan: "pro" });
  useGoalOnMount("paywall_viewed", { source: "home" });
  return (
    <button type="button" onClick={() => dg.track("cta_click")}>
      Go
    </button>
  );
}

describe("React", () => {
  it("DataGoatProvider adds the tracker once; hooks queue goals and identify", () => {
    const view = render(
      <DataGoatProvider websiteId="dfid_abc" domain="example.com">
        <Page />
      </DataGoatProvider>,
    );
    view.rerender(
      <DataGoatProvider websiteId="dfid_abc" domain="example.com">
        <Page />
      </DataGoatProvider>,
    );
    expect(document.querySelectorAll("script[data-website-id]")).toHaveLength(1);
    view.getByText("Go").click();
    expect(w().datafast?.q).toEqual([
      ["identify", { plan: "pro", user_id: "user_9" }],
      ["paywall_viewed", { source: "home" }],
      ["cta_click"],
    ]);
  });
});

describe("Next.js", () => {
  it("DataGoatScript renders the queue and the deferred tracker tag", () => {
    const html = renderToStaticMarkup(
      <DataGoatScript
        websiteId="dfid_abc"
        domain="example.com"
        host="https://a.example.com"
        nonce="xyz"
      />,
    );
    expect(html).toContain(`<script id="datagoat-queue" nonce="xyz">${QUEUE_SNIPPET}</script>`);
    expect(html).toContain('defer=""');
    expect(html).toContain('src="https://a.example.com/js/script.js"');
    expect(html).toContain('data-website-id="dfid_abc"');
    expect(html).toContain('data-api-url="https://a.example.com/api/events"');
    const bare = renderToStaticMarkup(<DataGoatScript websiteId="dfid_abc" queue={false} />);
    expect(bare).not.toContain("datagoat-queue");
    expect(bare).toContain('src="/js/script.js"');
  });

  it("the queue snippet is valid JavaScript that queues calls", () => {
    const fn = new Function(`${QUEUE_SNIPPET} window.datafast("signup", {a: "1"});`);
    fn();
    expect(Array.from(w().datafast?.q?.[0] ?? [])).toEqual(["signup", { a: "1" }]);
  });

  it("withDataGoat adds proxy rewrites before the app's own", async () => {
    expect(dataGoatRewrites({ host: "https://dg.example.workers.dev/", variant: "hash" })).toEqual([
      { source: "/js/script.js", destination: "https://dg.example.workers.dev/js/script.hash.js" },
      { source: "/api/events", destination: "https://dg.example.workers.dev/api/events" },
    ]);
    expect(() => dataGoatRewrites({ host: "dg.example.com" })).toThrow(/origin/);

    const none = withDataGoat(
      { reactStrictMode: true },
      { host: "https://dg.test", eventsPath: "/e" },
    );
    expect(none.reactStrictMode).toBe(true);
    const r1 = await none.rewrites?.();
    expect(r1).toEqual({
      beforeFiles: [
        { source: "/js/script.js", destination: "https://dg.test/js/script.js" },
        { source: "/e", destination: "https://dg.test/api/events" },
      ],
      afterFiles: [],
    });

    const arr = withDataGoat(
      { rewrites: async () => [{ source: "/a", destination: "/b" }] },
      { host: "https://dg.test" },
    );
    const r2 = (await arr.rewrites?.()) as { afterFiles: unknown[] };
    expect(r2.afterFiles).toEqual([{ source: "/a", destination: "/b" }]);

    const obj = withDataGoat(
      {
        rewrites: () => ({
          beforeFiles: [{ source: "/x", destination: "/y" }],
          fallback: [{ source: "/f", destination: "/g" }],
        }),
      },
      { host: "https://dg.test" },
    );
    const r3 = (await obj.rewrites?.()) as {
      beforeFiles: Array<{ source: string }>;
      fallback: unknown[];
    };
    expect(r3.beforeFiles.map((r) => r.source)).toEqual(["/js/script.js", "/api/events", "/x"]);
    expect(r3.fallback).toHaveLength(1);
  });
});
