import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ApiError } from '../api/client';
import * as sessionApi from '../api/session';

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

interface SessionContextValue {
  status: SessionStatus;
  scope: string | undefined;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [scope, setScope] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce forces a fresh whoami after a retry
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    sessionApi
      .whoami()
      .then((session) => {
        if (cancelled) return;
        setStatus('authenticated');
        setScope(session.scope);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setStatus('unauthenticated');
        } else {
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const login = useCallback(async (password: string) => {
    const session = await sessionApi.login(password);
    setStatus('authenticated');
    setScope(session.scope);
  }, []);

  const logout = useCallback(async () => {
    try {
      await sessionApi.logout();
    } finally {
      setStatus('unauthenticated');
      setScope(undefined);
    }
  }, []);

  const retry = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  const value = useMemo(
    () => ({ status, scope, login, logout, retry }),
    [status, scope, login, logout, retry],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
