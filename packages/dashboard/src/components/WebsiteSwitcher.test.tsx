import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Site } from '../api/types';
import { WebsiteSwitcher } from './WebsiteSwitcher';

const mockState = vi.hoisted(() => ({
  sites: [] as Site[],
  selectedSite: null as Site | null,
  selectSite: vi.fn(),
  isLoading: false,
}));

vi.mock('../hooks/useSelectedSite', () => ({
  useSelectedSite: () => ({
    sites: mockState.sites,
    selectedSite: mockState.selectedSite,
    selectSite: mockState.selectSite,
    isLoading: mockState.isLoading,
    isError: false,
  }),
}));

const SITES: Site[] = [
  {
    id: 'site_1',
    name: 'Example Site',
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
];

beforeEach(() => {
  mockState.sites = SITES;
  mockState.selectedSite = SITES[0];
  mockState.isLoading = false;
  mockState.selectSite.mockReset();
});

describe('WebsiteSwitcher', () => {
  it('lists the sites with the selected site active', () => {
    render(<WebsiteSwitcher />);

    expect(screen.getByRole('combobox', { name: 'Website' })).toHaveValue('site_1');
    expect(screen.getByRole('option', { name: 'Example Site' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'acme.test' })).toBeInTheDocument();
  });

  it('falls back to the domain when the site has no name', () => {
    mockState.selectedSite = SITES[1];
    render(<WebsiteSwitcher />);

    expect(screen.getByRole('combobox', { name: 'Website' })).toHaveValue('site_2');
    expect(screen.getByRole('option', { name: 'acme.test' })).toBeInTheDocument();
  });

  it('selects another site', async () => {
    render(<WebsiteSwitcher />);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Website' }), 'site_2');

    expect(mockState.selectSite).toHaveBeenCalledWith('site_2');
  });

  it('renders a skeleton while sites load', () => {
    mockState.isLoading = true;
    const { container } = render(<WebsiteSwitcher />);

    expect(container.querySelector('.website-switcher__skeleton')).not.toBeNull();
  });

  it('renders nothing without a site', () => {
    mockState.selectedSite = null;
    const { container } = render(<WebsiteSwitcher />);

    expect(container).toBeEmptyDOMElement();
  });
});
