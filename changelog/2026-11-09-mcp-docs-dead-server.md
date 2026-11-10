# MCP Docs: no more blank tabs from a folder server that stopped answering

- `[desktop]` A folder server told to stop could close its port and then wait forever for a window's open connections, and every tab sent to it came up blank. It now closes every connection and ends within three seconds, and the app asks a server whether it answers before sending a tab to it, replacing one that does not.
- `[desktop]` A page that fails to load is tried again once, then shown as an error with the reason; a renderer that dies is reloaded. The app writes a log (`~/Library/Logs/MCP Docs/mcp-docs.log` on a Mac) of the shell and the folder servers.
- `[desktop]` A server's start waits for its port message rather than the first message of any kind; a file given on the command line opens as a file.

## Feature

- MCP Docs no longer shows an empty tab when a file is opened from the Finder or appears in Downloads while the folder's server has stopped; the app starts a fresh one and shows the file.
