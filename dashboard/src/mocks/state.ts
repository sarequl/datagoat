/** Mutable mock state (signed-in user, websites). `resetMockState()` restores the defaults. */
import type { Website } from "../../../shared/api-types";
import { demoUser, websites as seedWebsites } from "./fixtures/core";

export interface MockState {
  signedIn: boolean;
  needsSetup: boolean;
  user: typeof demoUser;
  websites: Website[];
}

function initial(): MockState {
  return {
    signedIn: false,
    needsSetup: false,
    user: { ...demoUser },
    websites: seedWebsites.map((w) => ({ ...w })),
  };
}

export const state: MockState = initial();

export function resetMockState(overrides: Partial<MockState> = {}): void {
  Object.assign(state, initial(), overrides);
}
