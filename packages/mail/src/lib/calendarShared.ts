// What Mail's invitation card shares with Calendar (packages/calendar/src/lib): how an event's time reads on Calendar's own
// card ("Thursday, November 5 · 10 – 11am"), and a repeat rule in words ("Every week on Tuesday"). Imported from Calendar's
// sources, as lib/docsAgent.ts imports Docs', so the two cards cannot drift apart.
export { cardWhen } from '../../../calendar/src/lib/format';
export { describeRecurrence } from '../../../calendar/src/lib/recurrence';
