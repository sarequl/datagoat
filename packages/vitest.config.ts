import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Ecosystem (W8) unit tests: the browser SDK (happy-dom), the React Native SDK core (node), the
// mobile app's data layer (node) and the Shopify storefront loader (happy-dom).
// Run with `npm run test:ecosystem`.
// Injected <script> tags "load" without fetching anything.
const quietDom = {
  happyDOM: {
    settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true },
  },
};

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          name: "sdk",
          root: "packages/sdk",
          environment: "happy-dom",
          environmentOptions: quietDom,
          include: ["test/**/*.test.{ts,tsx}"],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: {
            "react-native": fileURLToPath(
              new URL("./react-native/test/react-native-stub.ts", import.meta.url),
            ),
          },
        },
        test: {
          name: "react-native",
          root: "packages/react-native",
          environment: "node",
          include: ["test/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "mobile",
          root: "apps/mobile",
          environment: "node",
          include: ["src/lib/**/*.test.ts"],
        },
        // apps/mobile/tsconfig.json extends expo/tsconfig.base.json, which exists only after
        // `npm ci` inside apps/mobile (it keeps its own lockfile). The data-layer tests need no
        // Expo code, so give the transformer an inline config and skip that lookup.
        esbuild: { tsconfigRaw: '{"compilerOptions":{"target":"ES2022","strict":true}}' },
      },
      {
        test: {
          name: "shopify-loader",
          root: "packages/test",
          environment: "happy-dom",
          environmentOptions: quietDom,
          include: ["**/*.test.ts"],
        },
      },
    ],
  },
});
