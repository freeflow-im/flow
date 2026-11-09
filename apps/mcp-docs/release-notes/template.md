The desktop app for macOS (Apple silicon) and Windows (x64). It opens a folder on your computer as its library and edits the files in place.

{{NOTES}}

**Install**

Easiest: run `npx @freeflow-im/mcp-docs` in a terminal (Terminal on a Mac, PowerShell on Windows); it installs or updates this app and the Claude Code and Codex plugins. Or by hand:

On a Mac:

1. Download `MCP-Docs-{{VERSION}}-mac-arm64.zip` and unzip it.
2. Move **MCP Docs** to Applications (replacing the older version) and open it.
3. The app is not notarized by Apple, so macOS stops it the first time ("Apple could not verify…"). Click **Done**, then open **System Settings › Privacy & Security**, scroll down and click **Open Anyway** next to MCP Docs. On macOS 14 and earlier, right-click the app and choose **Open** instead.

If macOS still won't open it, run this in Terminal and open it again:
`xattr -dr com.apple.quarantine "/Applications/MCP Docs.app"`

Intel Macs are not supported by this build.

On Windows:

1. Download `MCP-Docs-{{VERSION}}-win-x64-setup.exe` and run it.
2. The app is not signed, so Windows SmartScreen stops it ("Windows protected your PC"). Click **More info**, then **Run anyway**.

