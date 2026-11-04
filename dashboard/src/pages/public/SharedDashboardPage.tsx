import { PagePlaceholder } from "../../components/PagePlaceholder";

/** Placeholder: W4 replaces this page. */
export default function SharedDashboardPage() {
  return (
    <PagePlaceholder
      title="Shared dashboard"
      owner="W4"
      description="Read-only overview for /share/:token."
    />
  );
}
