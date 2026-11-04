/** Node mock API for Vitest (dashboard tests). */
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);
