# Docs: the assistant floats over the page

- `[web]` `[desktop]` Docs' assistant is a floating "Ask Assistant" pill in the page's bottom-right corner that opens into a floating panel (normal or expanded), per the floating-assistant design; the panel's anchor button docks it as the side panel beside the page, as before, and the docked panel can be set afloat again. Placement and size are remembered.
- `[web]` `[desktop]` The floating panel minimizes itself to the pill after two minutes with no new text from the user or the assistant (not while a turn runs or a question waits; the docked panel stays).
- `[web]` The panel keeps its draft when anchored or set afloat (one wrapper for every state, no remount); closing the docked panel brings the pill back.

## Feature

- **Ask the assistant without losing space.** In Docs the assistant now floats over your file as a small "Ask Assistant" button. Click it to chat in a floating panel, make the panel bigger, or anchor it beside your file like before. It remembers how you left it, and the floating panel tucks itself away after two quiet minutes.
