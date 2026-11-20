import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FilesCard, InboxCard, TodayCard } from './Cards';

describe('cards for a person with nothing linked (platform.md §3.2)', () => {
  it('asks for a calendar when there is none, and shows the day when there is one', () => {
    const { rerender } = render(<TodayCard events={[]} error={null} settingUp={false} hasCalendar={false} />);
    expect(screen.getByText(/No calendar linked yet/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Link a calendar' }).getAttribute('href')).toBe('/calendar/');
    rerender(<TodayCard events={[]} error={null} settingUp={false} hasCalendar />);
    expect(screen.getByText('Nothing on your calendar today.')).toBeTruthy();
  });

  it('asks for an email account when there is none', () => {
    render(<InboxCard address={null} account={null} inboxPath={null} threads={null} hasAccount={false} error={null} settingUp={false} now={new Date()} />);
    expect(screen.getByRole('link', { name: 'Link your email' }).getAttribute('href')).toBe('/mail/');
  });
});

describe('the Recent files card', () => {
  it('shows every kind of Docs file, and one of a kind it does not know as a plain file', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const files = [
      { id: 'w1', name: 'Board', kind: 'whiteboard' as const, lastUsed: '2026-11-19T11:00:00Z' },
      { id: 'n1', name: 'Newer kind', kind: 'mindmap' as never, lastUsed: '2026-11-19T10:00:00Z' },
    ];
    render(<FilesCard files={files} error={null} now={now} />);
    expect(screen.getByRole('link', { name: /Board/ }).getAttribute('href')).toBe('/docs/w/w1');
    expect(screen.getByText('W')).toBeTruthy();
  });
});
