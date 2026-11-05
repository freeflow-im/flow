# The assistant runs again after an unreadable search key

- `[server]` The Brave Search key and the OpenAI key used for image editing were read with a plain decrypt on every turn, so a key saved before the Docs object sealed with FLOW_DATA_KEY failed every turn with "Something went wrong" even after the model key was entered again. Both reads now treat an unreadable key as not set; saving settings drops an unreadable Brave key, and Settings shows it as not set.
- `[edge]` The Docs app's logger writes an error's name, message, stack and cause to the Worker's logs: `req.log.error({ err }, …)` printed `{}` before, which hid this failure.

## Feature

- **The assistant works after re-entering your key.** A Brave Search key saved before the recent key fix no longer breaks every turn; it just counts as not set until you enter it again in Settings › Assistant.
