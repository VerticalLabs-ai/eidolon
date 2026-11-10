import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from '../src/components/ui/Tabs';

const tabs = [
  { id: 'home', label: 'Home' },
  { id: 'work', label: 'Work' },
  { id: 'activity', label: 'Activity' },
];

describe('Tabs', () => {
  const scrollIntoView = vi.fn();
  const original = Element.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it('scrolls sideways instead of spilling past a narrow container', () => {
    render(<Tabs tabs={tabs} activeTab="home" onTabChange={() => {}} />);

    const row = screen.getByRole('button', { name: 'Home' }).parentElement;
    expect(row).toHaveClass('overflow-x-auto');
    for (const tab of tabs) {
      expect(screen.getByRole('button', { name: tab.label })).toHaveClass('shrink-0');
    }
  });

  it('brings the active tab into view, including one selected by a deep link', () => {
    const { rerender } = render(<Tabs tabs={tabs} activeTab="activity" onTabChange={() => {}} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('button', { name: 'Activity' }));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' });

    rerender(<Tabs tabs={tabs} activeTab="work" onTabChange={() => {}} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(screen.getByRole('button', { name: 'Work' }));
  });

  it('reports the tab that was chosen', async () => {
    const onTabChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="home" onTabChange={onTabChange} />);

    await userEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(onTabChange).toHaveBeenCalledWith('activity');
  });
});
