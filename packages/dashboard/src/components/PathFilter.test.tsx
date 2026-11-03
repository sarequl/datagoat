import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathFilter } from './PathFilter';

describe('PathFilter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the typed path after the debounce', () => {
    const onApply = vi.fn();
    render(<PathFilter value="" onApply={onApply} />);

    fireEvent.change(screen.getByLabelText('Filter by path'), { target: { value: '/blog' } });
    expect(onApply).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onApply).toHaveBeenCalledWith('/blog');
  });

  it('does not call onApply when the value is unchanged', () => {
    const onApply = vi.fn();
    render(<PathFilter value="/blog" onApply={onApply} />);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onApply).not.toHaveBeenCalled();
  });
});
