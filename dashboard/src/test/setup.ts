import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "../mocks/node";
import { resetMockState } from "../mocks/state";

// findBy* and waitFor default to 1 s, which is too tight on a loaded CI runner: a page that
// renders after several mock requests can exceed it and fail intermittently.
configure({ asyncUtilTimeout: 5000 });

// happy-dom's IntersectionObserver never reports anything; treat every element as on screen so
// cards that load when scrolled into view (WhenVisible) render in tests.
class VisibleObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    this.cb(
      [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver = VisibleObserver as unknown as typeof IntersectionObserver;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  // Preferences saved by one test (open panels, hidden cards) must not leak into the next.
  window.localStorage.clear();
  server.resetHandlers();
  resetMockState();
  window.history.replaceState(null, "", "/");
});
afterAll(() => server.close());
