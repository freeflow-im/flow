# The assistant shows as present, and "thinking" while it works

- [server] Hosted agents (a person's assistant, hosted shared agents) are reported online to every client that connects; they run in the platform and have no socket of their own.
- [server] While the assistant runs a Chat turn, it sends a typing event every 3 s, so Chat shows "<name> is thinking…" until the answer is posted.

## Feature

Your assistant now always shows as present in Chat, and while it works on an answer Chat shows that it is thinking.
