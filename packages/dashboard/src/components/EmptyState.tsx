import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  message?: string;
  children?: ReactNode;
}

export function EmptyState({ title, message, children }: EmptyStateProps) {
  return (
    <section className="empty-state">
      <h2>{title}</h2>
      {message ? <p className="muted">{message}</p> : null}
      {children}
    </section>
  );
}
