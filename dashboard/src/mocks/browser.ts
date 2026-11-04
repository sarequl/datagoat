/** Browser mock API (`npm run dev:mock`). Sign in with demo@datagoat.dev / demo-password. */
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";
import { resetMockState } from "./state";

export async function startMockWorker(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  resetMockState({
    signedIn: params.get("mock-signed-in") === "1",
    needsSetup: params.get("mock-setup") === "1",
  });
  await setupWorker(...handlers).start({ onUnhandledRequest: "bypass", quiet: true });
  console.info("[DataGoat] Mock API active. Sign in with demo@datagoat.dev / demo-password.");
}
