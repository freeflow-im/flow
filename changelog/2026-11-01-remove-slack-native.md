# Remove the Slack provider from the macOS and iOS apps

- `[macos]` `[ios]` The Slack provider is gone from the shared Swift code: `SlackBackend`, `SlackBrowserSignIn`, `SlackIdentity`, the `WorkspaceBackend` protocol and the engine's provider branches, Connect Slack in Workspaces and servers, "Open in Slack", the provider-limits banner, history-limit waits, the sidebar's "Show N inactive" fold and `Channel.lastActivityAt` (the v25 column stays, unread). `WorkspaceBackend.swift` becomes `Capabilities.swift`: the capability gating stays for archived channels.
- `[macos]` `[ios]` A registry saved by an earlier build with a Slack connection loads: that connection and its session, bindings and navigation are dropped on read (`ConnectionRegistry.init(from:)`), and the active connection falls back to a remaining server.
- `[ios]` The share extension sends to Flow servers only; `project.yml` drops the Slack sources from `FlowShare` and the Slack suites from `FlowUnitTests`. Run `xcodegen generate`.
- `[macos]` `[ios]` Mentions accept Flow user ids only (`<@uuid>`).
