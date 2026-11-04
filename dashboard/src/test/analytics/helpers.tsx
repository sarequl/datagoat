import { configure } from "@testing-library/react";
import { resetMockState } from "../../mocks/state";
import { renderApp } from "../render";

// Pages fetch several endpoints and lazy chunks; give async queries room on slow CI machines.
configure({ asyncUtilTimeout: 5000 });

export const SITE = "6728f0a0a1b2c3d4e5f6a001";

/** Render a signed-in website page against the mock API. */
export function renderSite(path: string) {
  resetMockState({ signedIn: true });
  return renderApp(`/app/${SITE}/${path}`);
}

export function search(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}
