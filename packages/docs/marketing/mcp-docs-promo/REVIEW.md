# Review: MCP Docs promo (first delivery)

## Creative calls
- Concept "the action log" (picked in the pitch round), reordered by the user: any file → "Connect any agent
  with MCP" → the assistant at work → claim → end card. The slide-checking scene and the "That was the agent /
  Your turn" pivot were cut at the user's request.
- Real footage only: the screen recording (sped 1.5× in places, two long waits cut) and the six screenshots.
  The only drawn elements are the cursor, selection highlights, the signature and the end-card logo, which is
  rebuilt from the app's own SVG at its own colours.
- Look from the capture of docs.freeflow.im: #f0f4f9 chrome, #1a73e8 accent, Google Sans Flex (the OFL release
  of the app's Google Sans).
- Storylines not built: #2 "Your agent, my window" (only its `npx` close is used), #3 one file through every
  editor, #4 the reversed ⌘Z film, #5 the struck-through subscription receipt.

## Measured vs looked at
- `check` passes with no errors. Seam sheets, beat sheets and the phone sheet were looked at. Four seams that
  flashed the empty ground (8.5, 11.0, 32.8, 38.3 s) were fixed by keeping the outgoing scene under each wipe.
- **No sound.** No music source was available (no HeyGen CLI, no local MusicGen), so the film is delivered
  silent. Nothing was heard or measured.

## Weakest shot
- The "any file" gestures are animated over still screenshots (the selection, the highlight, the signature, the
  click). Short real recordings of each edit would be more convincing.
- At phone width the assistant's log lines (41 px) and the MCP subline are small. The target is YouTube, the
  README and the site, so they were kept.

## Warnings kept on purpose
- `film_silent`: no music source yet (above).
- `nested_media_start_basis_ambiguous`: the recording's cuts are deliberately timed locally inside their scenes.
- `duplicate_media_discovery_risk`: the four cursor images in `files.html` share one source on purpose.
- `timeline_track_too_dense`: `files.html` holds the five editor worlds as one sequence on purpose.
