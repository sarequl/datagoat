import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeToggle } from './ThemeToggle';

describe('ThemeToggle', () => {
  it('toggles the theme on the document element', async () => {
    render(<ThemeToggle />);

    const button = screen.getByRole('button', { name: /switch to/i });
    const before = document.documentElement.dataset.theme;

    await userEvent.click(button);

    expect(document.documentElement.dataset.theme).not.toBe(before);
  });
});
