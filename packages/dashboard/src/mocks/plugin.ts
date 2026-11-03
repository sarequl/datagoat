import type { Plugin } from 'vite';
import { handleMockRequest } from './router.ts';

type NextFunction = (error?: unknown) => void;
type Middleware = (
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  next: NextFunction,
) => void;

// Serves the typed mock `/api/v1` from Vite's dev and preview servers. The
// production build is served by the Worker, so this never runs there.
export function mockApiPlugin(): Plugin {
  const middleware: Middleware = (request, response, next) => {
    if (!request.url?.startsWith('/api/v1/')) {
      next();
      return;
    }
    handleMockRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      response.end(JSON.stringify({ error: { code: 500, message: 'Mock server error' } }));
    });
  };

  return {
    name: 'datagoat-mock-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
