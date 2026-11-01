---
title: AI presentation editor for PowerPoint files, with MCP
description: Open, edit and save PowerPoint (.pptx) presentations with an AI assistant beside them, or let Claude Code, Codex or any MCP client build and edit the slides while you watch.
image: slides
order: 1
alt: A presentation on multi-head attention, with a diagram of eight attention heads
---

# Edit PowerPoint presentations with your AI agent

MCP Docs opens PowerPoint files and saves them back as `.pptx`. You edit slides the way you would in any presentation app, and your AI agent edits the same deck: ask the built-in assistant, or connect Claude Code, Codex or another MCP client and watch each slide change as it works.

## What you can do

- **Open and save PowerPoint files.** Text, pictures, shapes, lines, tables, charts and videos are read from the file and written back to it. In the desktop app the file in your folder stays a PowerPoint file; on the web, download it as one at any time.
- **Lay out slides.** Title, section, content, two-column and picture layouts, and six themes (Light, Dark, Ocean, Forest, Sunset and Paper) that restyle the whole deck at once.
- **Tables and charts from your spreadsheets.** Link a table or a chart on a slide to a range in a spreadsheet. When the numbers in the spreadsheet change, the slide follows.
- **Pictures and video.** Crop a picture on the slide, edit it in the image editor, or add a video file or a YouTube video that plays in the show.
- **Present from the app.** Show the deck full screen with the keyboard, or download it as a PDF.
- **Find and undo.** Find text across every slide. Every change, yours or the agent's, can be undone.

## Work on a deck with your agent

Ask the assistant beside the deck in plain words:

- "Turn this paper into a ten-slide presentation."
- "Make slide 4 a two-column comparison and add a chart of the quarterly numbers."
- "Use the Ocean theme and shorten every bullet to one line."

The agent reads the deck slide by slide, makes its edits as undoable steps, and can look at a picture of a slide to check its own work. In the desktop app the same tools are an MCP server on your machine, so an agent you already use can do it too:

```sh
npx @freeflow-im/mcp-docs
```

That installs the app and adds it to Claude Code and Codex. Any other MCP client can connect to the address the installer prints.

## Frequently asked questions

### Can I open a presentation made in PowerPoint or Keynote?

Yes, as a PowerPoint (`.pptx`) file. Keynote and Google Slides can both export one. In the desktop app, a file that holds something MCP Docs cannot keep, such as an animation, opens read-only and lists what would be lost, so you choose before anything in it changes.

### Does it save in PowerPoint format?

Yes. In the desktop app the file in your folder stays a `.pptx` file, so it opens in PowerPoint, Keynote and Google Slides. Only a deck with something PowerPoint cannot store asks first before it is kept in MCP Docs' own format.

### Which AI models can edit my slides?

The built-in assistant runs on Claude, or on your own Anthropic, OpenAI or OpenRouter key. In the desktop app it can also run on the Claude Code you already have. Over MCP, any agent you connect can edit them.

### Is it free?

Yes. MCP Docs is free and open source, for Macs with Apple silicon and 64-bit Windows, and in beta on the web.
