/**
 * Entry point of the three tracker builds (tracker/build.mjs): installs `window.datafast` and
 * `window.datagoat`, drains the pre-load queue and starts tracking. See tracker.ts.
 */
import { init } from "./tracker";

init(window as unknown as Parameters<typeof init>[0]);
