# The assistant floats over the page in Docs, Mail and Calendar

- `[web]` `[desktop]` The assistant is a floating "Ask Assistant" pill in the page's bottom-right corner that opens into a floating panel (normal or expanded), per the floating-assistant design; the panel's anchor button docks it as the side panel beside the page, as before, and the docked panel can be set afloat again. Placement and size are remembered per app.
- `[web]` `[desktop]` The floating panel minimizes itself to the pill after two minutes with no new text from the user or the assistant (not while a turn runs or a question waits; the docked panel stays).
- `[web]` `[desktop]` Closing the assistant (by hand or by that timer) ends the chat: the next open starts a new one. A turn still running finishes first, and the chat stays if the panel is opened again before it has.
- `[web]` One dock for the suite: `packages/suite-bar/src/AssistantDock.tsx` (the pill, the box, the header buttons, the idle timer) wraps each app's own panel, so Docs, Mail and Calendar behave the same; the panel keeps its draft when anchored or set afloat, and closing the docked panel brings the pill back.

## Feature

- **Ask the assistant without losing space.** In Docs, Mail and Calendar the assistant now floats over your work as a small "Ask Assistant" button. Click it to chat in a floating panel, make the panel bigger, or anchor it beside the page like before. Each app remembers how you left it, and the floating panel tucks itself away after two quiet minutes. Closing the assistant ends the conversation, so it opens fresh next time.
