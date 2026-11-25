# Calendar: show how far the day or week view is from today

- [web] Off today's day or week, Today turns solid blue with an arrow toward today, a chip beside the title reads "Next week", "In 2 weeks", "3 days ago"…, and a blue rule runs under the toolbar; no layout shift (Taskboard task 43).
- [qa] `Toolbar.test.tsx` covers `offsetOf` and both toolbar states.

## Feature

When Calendar's Day or Week view isn't showing today, the Today button lights up with an arrow pointing back to it, and a small label next to the dates tells you how far away you are, such as "In 2 weeks" or "Yesterday".
