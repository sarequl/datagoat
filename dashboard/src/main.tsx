import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { applyTheme } from "./components/ThemeToggle";
import "./styles.css";

async function start() {
  try {
    const saved = localStorage.getItem("dg-theme");
    if (saved === "light" || saved === "dark") applyTheme(saved);
  } catch {
    // storage unavailable
  }
  if (__MOCK_API__) {
    const { startMockWorker } = await import("./mocks/browser");
    await startMockWorker();
  }
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
