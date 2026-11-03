import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSites } from './useSites';

const STORAGE_KEY = 'datagoat.site';

function readStoredSiteId(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function useSelectedSite() {
  const sitesQuery = useSites();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSiteId = searchParams.get('site') ?? undefined;
  const [storedSiteId, setStoredSiteId] = useState(readStoredSiteId);

  const sites = sitesQuery.data ?? [];
  const selectedSite =
    sites.find((site) => site.id === urlSiteId) ??
    sites.find((site) => site.id === storedSiteId) ??
    sites[0];

  const selectSite = useCallback(
    (siteId: string) => {
      setStoredSiteId(siteId);
      try {
        window.localStorage.setItem(STORAGE_KEY, siteId);
      } catch {
        // localStorage can be unavailable; the URL still holds the selection.
      }
      const params = new URLSearchParams(searchParams);
      params.set('site', siteId);
      // A path filter is site-specific and does not carry over to another site.
      params.delete('path');
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return {
    sites,
    selectedSite,
    selectSite,
    isLoading: sitesQuery.isLoading,
    isError: sitesQuery.isError,
  };
}
