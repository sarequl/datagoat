import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "../mocks/node";
import { resetMockState } from "../mocks/state";

// findBy* and waitFor default to 1 s, which is too tight on a loaded CI runner: a page that
// renders after several mock requests can exceed it and fail intermittently.
configure({ asyncUtilTimeout: 5000 });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetMockState();
  window.history.replaceState(null, "", "/");
});
afterAll(() => server.close());
