# Docs: a Whiteboard file type

- `[web]` `[desktop]` New kind `whiteboard` (`shared/whiteboard.ts`, `/api/whiteboards`, page `/w/:id`): a 5760×3600 board edited with the slide editor in a whiteboard mode.
- `[web]` Text tool (typed text stays where it was typed and grows with its lines), sticky notes, shapes, lines, Upload image and ⌘V; positions and sizes snap to a 4-point grid; pictures draw above text.
- `[web]` Text being typed on a whiteboard takes ⌘B / ⌘I / ⌘U on a few words, and the slide editor now keeps bold, italic and colored words through a re-edit.
- `[web]` The assistant has no whiteboard tools yet; a whiteboard's text is searchable and exports as JSON.

## Feature

- **Whiteboards in Docs.** Make a Whiteboard from New: a large board, about four screens each way, that you scroll around. Click anywhere with the Text tool and type, add sticky notes, shapes and lines, and drop in pictures with Upload image or ⌘V. Everything lines up on an invisible grid.
