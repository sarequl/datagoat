import { useSelectedSite } from '../hooks/useSelectedSite';
import { Skeleton } from './Skeleton';

export function WebsiteSwitcher() {
  const { sites, selectedSite, selectSite, isLoading } = useSelectedSite();

  if (isLoading) {
    return <Skeleton className="website-switcher__skeleton" />;
  }
  if (!selectedSite) {
    return null;
  }

  return (
    <label className="website-switcher">
      <span className="visually-hidden">Website</span>
      <select
        className="website-switcher__select"
        value={selectedSite.id}
        onChange={(event) => selectSite(event.target.value)}
      >
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.name ?? site.domain}
          </option>
        ))}
      </select>
    </label>
  );
}
