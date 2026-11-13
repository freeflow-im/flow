# Calendar: the month view shows events again

- `[web]` The month grid drew every event as an empty line since 2026-11-09 (`eventContent` returned `undefined`, which FullCalendar 6 under React renders as nothing); it returns `true` for the default content now. Test in `CalendarGrid.test.tsx`.

## Feature

- **Month view fixed.** Events in Calendar's month view show their time and title again, instead of thin lines.
