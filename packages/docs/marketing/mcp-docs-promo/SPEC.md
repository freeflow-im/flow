# SPEC: MCP Docs promo, "The action log"

GOAL:    The viewer leaves knowing MCP Docs is one editor for every file, where an agent and a person work on
         the same document, and that they can install it with one command.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps
TIME:    44.8 s x 30 = 1344 frames. Planned on a 120 BPM grid (15 frames a beat, 60 a bar) until a track is
         chosen; the cuts move to the track's beats then.
LOOK:    The product's own medium: Google-style light app chrome.
         Ground #f0f4f9 (app chrome), panels #ffffff, ink #1f1f1f, muted #5f6368, hairline #dadce0.
         Accent #1a73e8 (app blue), used only on: the agent's word in the claim, the S6 colour field, the
         end-card command's caret. Check green #0f9d58 only on log ticks.
         Display: Google Sans Flex 500, 84 px (7.8% of height), tracking -1.5%. Log lines: 500, 46 px.
         Quiet lines: 400, 34 px, #5f6368. Command: JetBrains Mono 500, 44 px.
         Windows: radius 18 px, shadow 0 24px 60px rgba(31,31,31,0.16), 1 px #dadce0 border. No grain,
         no vignette.
OBJECTS: The real MCP Docs window (screen recording + screenshots, never redrawn). Its assistant panel with
         green ticks. The 4-square logo (assets/logo.svg) and the per-editor icons (assets/icons/). A large
         macOS arrow cursor, 60 px tall (5.5% of frame).
MOTION:  Enter: expo.out 0.5 s. Camera: power2.inOut 0.6 s with motion blur. Exit / zoom through: power3.in
         0.35 s. Titles: per word blur(6px) to 0 + opacity, 0.13 s each, 0.07 s apart; then dead still.
         Log lines: tick pops (scale 0.6 to 1, back.out(1.6), 0.25 s), text wipes in left to right 0.3 s.
         Stagger list items 60 ms.
SHOTS:
  S1  0.0-8.5    Any file, five worlds, 1.7 s each. Excel is on screen at frame 0 (a selection drag); then by
                 whip Word (title selected), Markdown (the heading lit in source and preview), PDF (a signature
                 written), HTML (a button clicked). Each names its format in one large word on a white plate.
  S2  8.5-11.0   White field whips up: "Every file, one editor".
  S3  11.0-14.8  Blue irises out of "editor": "Connect any agent with MCP", then "Claude Code · Codex · any MCP
                 client". The blue closes onto where the app window opens.
  S4  14.8-21.3  Home stage: the window opens on the real PDF, "An 11-page paper"; the camera pans to the
                 assistant at 1.6x, "Ask the assistant"; the prompt types; the cursor clicks Send.
  S5  21.3-27.8  The action log: the panel's own lines land large, one tick each, timed to the recording
                 (1.5x, waits cut). The deck opens; the camera pulls back to the whole app.
  S6  27.8-32.8  Payoff, full bleed: the title slide fills the frame, punch cut to the results slide as the
                 agent edits it, pull back to the whole app.
  S7  32.8-38.3  White. "A universal editor for any file", then "for humans and agents", "agents" in blue.
  S8  38.3-44.8  End card: the four logo squares lock into the mark, "MCP Docs" wipes in, the install command
                 types, "Open source · macOS · Windows"; hold to the end.
BANNED:  dark void grounds; glow, particles, gradients; cream paper + serif; three cards in a row; a title over
         a dimmed screenshot; the logo docked in a corner; product UI tilted in 3D; breathing/floating loops;
         any UI that is not in the recording or screenshots; the stale `@scottpersinger` npx line visible in
         pdf_example.png (crop it out); "Introducing", "seamless", "supercharge".
QA:      0.0 (thumbnail: Excel with its name), 2.6 / 4.6 / 6.2 / 7.9 (each editor names itself), 9.8 (line),
         12.6 (MCP line and clients), 19.6 (prompt legible), 25.6 (ticks legible), 30.4 (payoff full bleed),
         37.2 (claim), 44.2 (end card complete, command readable).
