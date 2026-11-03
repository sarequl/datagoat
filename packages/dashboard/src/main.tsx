import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api/client';
import { AppRouter } from './router';
import './styles/base.css';
import './styles/tokens.css';
import { applyTheme, getInitialTheme } from './theme';

// Applied before first paint so the shell renders in the saved theme. The
// Worker's CSP disallows inline scripts, so this lives in the module bundle.
applyTheme(getInitialTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        error instanceof ApiError && error.status >= 500 && failureCount < 2,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppRouter />
    </QueryClientProvider>
  </StrictMode>,
);
