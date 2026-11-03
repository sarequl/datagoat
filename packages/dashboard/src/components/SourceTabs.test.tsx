import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_TABS, SourceTabs } from './SourceTabs';

describe('SourceTabs', () => {
  it('marks the active tab', () => {
    render(<SourceTabs active="referrers" onSelect={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'Referrers' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Campaigns' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('renders every source dimension', () => {
    render(<SourceTabs active="referrers" onSelect={vi.fn()} />);

    for (const tab of SOURCE_TABS) {
      expect(screen.getByRole('tab', { name: tab.label })).toBeInTheDocument();
    }
  });

  it('selects a tab on click', async () => {
    const onSelect = vi.fn();
    render(<SourceTabs active="referrers" onSelect={onSelect} />);

    await userEvent.click(screen.getByRole('tab', { name: 'Pages' }));

    expect(onSelect).toHaveBeenCalledWith('pages');
  });

  it('moves selection with the arrow keys', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SourceTabs active="referrers" onSelect={onSelect} />);

    await user.tab();
    expect(screen.getByRole('tab', { name: 'Referrers' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenCalledWith('campaigns');
    expect(screen.getByRole('tab', { name: 'Campaigns' })).toHaveFocus();
  });
});
