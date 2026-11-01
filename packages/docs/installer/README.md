# @freeflow-im/mcp-docs

Installs **MCP Docs**, a Mac and Windows app for Word, PowerPoint and Excel files, Markdown, CSV, PDFs and pictures
in a folder on your computer, and the **mcp-docs** plugin for [Claude Code](https://claude.com/claude-code) and
[Codex](https://developers.openai.com/codex), which lets your coding agent open and edit those files while you watch
them change in the app. Any other MCP client can connect to the app too.

```
npx @freeflow-im/mcp-docs
```

This:

1. Downloads the latest MCP Docs release from GitHub and puts it in `/Applications` (or `~/Applications`),
   replacing an older version. On Windows it runs the release's setup program, which installs it for you.
2. For each of Claude Code and Codex it finds, asks whether to add the `mcp-docs` plugin, and if so adds the
   `mcp-docs` plugin marketplace and installs the plugin: the app's MCP server and a skill describing how to use it.
3. Starts the app, and prints its MCP address, `http://127.0.0.1:39217/mcp`.

Then sign in once: in Claude Code, restart it, run `/mcp` and sign in to `plugin:mcp-docs:mcp-docs`; in Codex, run
`codex mcp login mcp-docs`. The app asks you to allow each agent. Run `npx @freeflow-im/mcp-docs` again to update
everything.

**Any other MCP client** can connect to `http://127.0.0.1:39217/mcp` (streamable HTTP) while the app is running. It
signs in with OAuth 2.1 (dynamic client registration and PKCE), and the app asks you to allow it.

Options: `--claude`, `--codex` (add the plugin to these agents without asking, and not to the others), `--yes` (add
it to every agent found without asking), `--skip-app` (plugins only), `--skip-plugins` (app only).

To remove it all again:

```
npx @freeflow-im/mcp-docs --uninstall
```

This removes the app, its data and settings (the assistant's chats, API keys, connected agents) and what it
added to Claude Code (the plugin, its marketplace, and an `mcp-docs` server added by hand) and to Codex (the plugin
and its marketplace). It lists what it
will remove and asks first (`--yes` skips the question). Your documents, in the folders you opened, are not
touched.

Requires a Mac with Apple silicon or Windows (x64), and Node.js 18 or later.
