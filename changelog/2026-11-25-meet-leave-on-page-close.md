# Meet: no second tile when someone leaves and comes back

- `[web]` The Meet page now leaves RealtimeKit on `pagehide` (reload, tab close), for members and guests. Before, the
  old connection stayed about 13 s, so a quick rejoin showed the person twice.
- `[web]` After a crash or a lost network the page cannot say it left. A page that joins the same room again from the
  same browser now tells the room which old connection it replaces, and every page leaves that one out
  (`packages/meet/src/lib/rejoin.ts`). Two devices of one person stay two tiles.
- `[server]` A guest's browser sends a kept key, and the guest's RealtimeKit id is made from it, so a returning guest is
  the same participant.

## Feature

- **No more double tiles in Meet.** When someone reloads the page, closes the tab or loses their connection and joins
  again, the others now see that person once, not twice.
