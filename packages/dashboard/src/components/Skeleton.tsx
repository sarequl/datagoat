export function Skeleton({ className }: { className?: string }) {
  return <div className={`skeleton${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}

export function FullScreenSkeleton({ label }: { label?: string }) {
  return (
    <div className="full-screen-skeleton" role="status" aria-live="polite">
      <Skeleton className="full-screen-skeleton__bar" />
      <span className="muted">{label ?? 'Loading…'}</span>
    </div>
  );
}
