// DataGoat browser SDK (npm entry).
//
// The npm package loads the same core as the served t.js; it does not
// reimplement the protocol. `init()` returns the tracker instance.

import { createTracker, VERSION } from './core.js';
import { getCheckoutContext, setCheckoutMetadata } from './checkout.js';

export function init(options) {
  const tracker = createTracker(options || {});
  tracker.init();
  return tracker;
}

export { createTracker, getCheckoutContext, setCheckoutMetadata };
export const version = VERSION;

export default {
  init,
  getCheckoutContext,
  setCheckoutMetadata,
  createTracker,
  version,
};
