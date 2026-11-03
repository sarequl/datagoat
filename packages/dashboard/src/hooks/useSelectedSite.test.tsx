import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectedSite } from './useSelectedSite';

vi.mock('./useSites', () => ({
  useSites: () => ({
    data: [
      {
        id: 'site_1',
        name: 'Example',
        domain: 'example.com',
        timezone: 'UTC',
        currency: 'USD',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'site_2',
        name: null,
        domain: 'acme.test',
        timezone: 'America/New_York',
        currency: 'EUR',
        createdAt: '2026-02-01T00:00:00Z',
      },
    ],
    isLoading: false,
    isError: false,
  }),
}));

function Harness() {
  const { selectedSite, selectSite } = useSelectedSite();
  const location = useLocation();
  return (
    <div>
      <div data-testid="location">{location.search}</div>
      <div data-testid="selected">{selectedSite?.id ?? ''}</div>
      <button type="button" onClick={() => selectSite('site_2')}>
        Switch site
      </button>
    </div>
  );
}

function renderHarness(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Harness />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('useSelectedSite', () => {
  it('sets the site in the URL and localStorage and clears the path filter', async () => {
    renderHarness('/?site=site_1&path=%2Fblog');

    await userEvent.click(screen.getByRole('button', { name: 'Switch site' }));

    const search = screen.getByTestId('location').textContent ?? '';
    expect(search).toContain('site=site_2');
    expect(search).not.toContain('path=');
    expect(window.localStorage.getItem('datagoat.site')).toBe('site_2');
  });

  it('prefers the URL site over the stored site', () => {
    window.localStorage.setItem('datagoat.site', 'site_1');
    renderHarness('/?site=site_2');

    expect(screen.getByTestId('selected')).toHaveTextContent('site_2');
  });

  it('falls back to the stored site', () => {
    window.localStorage.setItem('datagoat.site', 'site_2');
    renderHarness('/');

    expect(screen.getByTestId('selected')).toHaveTextContent('site_2');
  });

  it('falls back to the first site', () => {
    renderHarness('/');

    expect(screen.getByTestId('selected')).toHaveTextContent('site_1');
  });
});
