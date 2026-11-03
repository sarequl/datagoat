import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found" message="The page you asked for does not exist.">
      <Link to="/">Back to the overview</Link>
    </EmptyState>
  );
}
