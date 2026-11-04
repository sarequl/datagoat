import { defineConfig } from "vitest/config";

/**
 * Tracker unit tests in a simulated browser (happy-dom), one project per build: the build-time
 * constants decide which variant of tracker/src/tracker.ts the tests exercise.
 *   default:    every test file except cookieless.test.ts and hash.test.ts
 *   cookieless: cookieless.test.ts
 *   hash:       hash.test.ts
 */
const variant = (
  name: "default" | "cookieless" | "hash",
  include: string[],
  exclude: string[] = [],
) => ({
  define: {
    __DG_COOKIELESS__: String(name === "cookieless"),
    __DG_HASH__: String(name === "hash"),
  },
  test: {
    name,
    root: "tracker",
    environment: "happy-dom",
    include,
    exclude,
  },
});

export default defineConfig({
  test: {
    projects: [
      variant("default", ["test/**/*.test.ts"], ["test/cookieless.test.ts", "test/hash.test.ts"]),
      variant("cookieless", ["test/cookieless.test.ts"]),
      variant("hash", ["test/hash.test.ts"]),
    ],
  },
});
