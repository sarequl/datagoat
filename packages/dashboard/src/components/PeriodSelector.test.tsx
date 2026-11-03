import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PeriodSelector } from './PeriodSelector';

function SearchProbe() {
  const location = useLocation();
  return <div data-testid="search">{location.search}</div>;
}

function renderSelector() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SearchProbe />
      <PeriodSelector timezone="UTC" />
    </MemoryRouter>,
  );
}

describe('PeriodSelector', () => {
  it('marks the default preset active', () => {
    renderSelector();
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('writes the selected preset to the URL', async () => {
    renderSelector();
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));

    const search = screen.getByTestId('search').textContent ?? '';
    expect(search).toContain('startAt=');
    expect(search).toContain('endAt=');
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes the compare flag to the URL', async () => {
    renderSelector();
    await userEvent.click(screen.getByLabelText('Compare to previous'));
    expect(screen.getByTestId('search').textContent).toContain('compare=previous');
  });
});
