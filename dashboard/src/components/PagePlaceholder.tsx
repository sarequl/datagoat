import { Card } from "./ui";

/** Shown by pages a feature team has not built yet. */
export function PagePlaceholder({
  title,
  owner,
  description,
}: {
  title: string;
  owner: string;
  description: string;
}) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <Card>
        <p className="text-sm text-muted">{description}</p>
        <p className="mt-3 text-xs text-muted" data-testid="placeholder-owner">
          Not built yet. Owner: {owner}. See docs/CONTRACTS.md.
        </p>
      </Card>
    </div>
  );
}
