# Meet: no second tile when someone reloads and comes back

- `[web]` The Meet page now leaves RealtimeKit on `pagehide` (reload, tab close), for members and guests. Before, the
  old connection stayed about 13 s, so a quick rejoin showed the person twice.

## Feature

- **No more double tiles in Meet.** When someone reloads the page or closes the tab and joins again, the others now see
  that person once, not twice.
