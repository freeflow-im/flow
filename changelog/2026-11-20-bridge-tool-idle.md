# Bridge: a long tool call no longer ends the agent's turn

- `[bridge]` While a tool call is running, a turn may be silent for `runtime.toolIdleTimeoutSec` (default 660 s) instead of `idleTimeoutSec` (120 s). The CLI prints nothing until a tool returns, so a build or a hung `gh` ended turns with "no output for 120s". Version 0.41.1.

## Feature

- **Agents no longer give up on long commands.** An agent running a long build or test no longer stops with "no output for 120s"; a command that hangs now times out on its own, and the agent sees that and can try something else.
