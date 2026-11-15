# Calendar side panel: the event card

- [web] An event clicked in the side panel's Calendar (Day or Week) opens Calendar's event card as a popup below it: details, guests, Going? Yes · No · Maybe; Edit opens Calendar in a new tab, no Delete.
- [web] Fix: leaving the Week list blanked the panel in newer Chrome (`scrollIntoView` returns a promise, which React called as a cleanup).

## Feature

Click an event in the Calendar side panel to see its details, answer an invitation, or open it in Calendar to edit.
