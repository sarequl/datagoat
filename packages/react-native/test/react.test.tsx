// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { AppState } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage, type DataGoatClient, type EventBody } from "../src/core";
import { nativePlatform, netInfoAdapter } from "../src/native";
import {
  DataGoatProvider,
  trackNavigation,
  useDataGoat,
  useDataGoatIdentify,
  useDataGoatScreen,
  useDataGoatTrack,
} from "../src/react";

const stub = AppState as unknown as { emit(s: string): void; listenerCount(): number };

function mockFetch() {
  const sent: EventBody[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response("{}");
  });
  return { sent, fetch: fetch as unknown as typeof globalThis.fetch };
}

const config = { websiteId: "dfid_app", domain: "example.com", host: "https://a.example.com" };

let client: DataGoatClient | null = null;

function Home() {
  client = useDataGoat();
  useDataGoatScreen("HomeScreen");
  useDataGoatIdentify("user_1", { plan: "pro" });
  const track = useDataGoatTrack();
  return (
    <button type="button" aria-label="Tap" onClick={() => track("cta_click", { source: "home" })} />
  );
}

describe("React bindings", () => {
  it("provider + hooks report screens, goals and identify, and flush on background", async () => {
    const { sent, fetch } = mockFetch();
    const view = render(
      <DataGoatProvider config={config} storage={createMemoryStorage()} fetch={fetch}>
        <Home />
      </DataGoatProvider>,
    );
    await act(async () => {
      await (client as DataGoatClient | null)?.ready;
    });
    await act(async () => {
      view.getByLabelText("Tap").click();
    });
    expect(stub.listenerCount()).toBe(1);
    await act(async () => {
      stub.emit("background");
      await (client as unknown as DataGoatClient).flush();
    });
    expect(sent.map((e) => e.type).sort()).toEqual(["custom", "identify", "pageview"]);
    expect(sent.find((e) => e.type === "pageview")?.href).toBe("datafast://ios/HomeScreen");
    view.unmount();
    expect(stub.listenerCount()).toBe(0);
  });

  it("trackNavigation reports the current route and every state change", async () => {
    const { sent, fetch } = mockFetch();
    const { DataGoatClient } = await import("../src/core");
    const client = new DataGoatClient(config, {
      storage: createMemoryStorage(),
      platform: nativePlatform(),
      fetch,
    });
    let route = "Home";
    let listener: () => void = () => undefined;
    const ref = {
      getCurrentRoute: () => ({ name: route }),
      addListener: (_e: "state", cb: () => void) => {
        listener = cb;
        return () => undefined;
      },
    };
    trackNavigation(client, ref);
    route = "Details";
    listener();
    await client.ready;
    await new Promise((r) => setTimeout(r, 0));
    await client.flush();
    expect(sent.map((e) => e.href)).toEqual(["datafast://ios/Home", "datafast://ios/Details"]);
  });

  it("nativePlatform reads Platform and Dimensions; netInfoAdapter detects reconnects", async () => {
    expect(nativePlatform()).toMatchObject({
      os: "ios",
      osVersion: "18.1",
      screen: { width: 393, height: 852 },
      window: { width: 393, height: 800 },
    });
    let emit: (s: { isConnected: boolean | null }) => void = () => undefined;
    const adapter = netInfoAdapter({
      fetch: async () => ({ isConnected: false }),
      addEventListener: (cb) => {
        emit = cb;
        return () => undefined;
      },
    });
    expect(await adapter.isOnline()).toBe(false);
    const onOnline = vi.fn();
    adapter.subscribe?.(onOnline);
    emit({ isConnected: false });
    emit({ isConnected: true });
    emit({ isConnected: true });
    expect(onOnline).toHaveBeenCalledTimes(1);
  });
});
