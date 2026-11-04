import { render } from "@testing-library/react";
import { App, createQueryClient } from "../app";

/** Render the whole app at `path` against the mock API. */
export function renderApp(path: string) {
  window.history.replaceState(null, "", path);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  return { queryClient, ...render(<App queryClient={queryClient} />) };
}
