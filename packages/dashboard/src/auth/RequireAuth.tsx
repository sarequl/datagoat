import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ErrorState } from '../components/ErrorState';
import { FullScreenSkeleton } from '../components/Skeleton';
import { useSession } from './SessionContext';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, retry } = useSession();
  const location = useLocation();

  if (status === 'loading') {
    return <FullScreenSkeleton label="Checking your session…" />;
  }

  if (status === 'error') {
    return (
      <ErrorState
        title="Cannot reach the server"
        message="The dashboard could not verify your session. Check your connection and try again."
        onRetry={retry}
      />
    );
  }

  if (status === 'unauthenticated') {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }

  return <>{children}</>;
}
