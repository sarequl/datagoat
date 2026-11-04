import { Card } from "./ui";

/** Shown by pages that are not available yet. */
export function PagePlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <Card>
        <p className="text-sm font-medium text-primary-text" data-testid="coming-soon">
          Coming soon
        </p>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </Card>
    </div>
  );
}
