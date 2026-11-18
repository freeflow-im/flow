# The assistant over installed apps

- `[web]` `[desktop]` An installed app's page (`/apps/<name>`) now shows the assistant pill. It opens into the floating panel, which can be expanded or anchored beside the app's screen, as in Admin and Home.
- `[server]` `/api/agent/agents?app=<name>` lists only the agents that may use that app for the person. A personal agent needs "My agents may use it" on, and a shared agent needs a grant. The panel's picker reads this list.
- `[server]` A turn from that panel tells the agent which app is open (`installedApp` context), so "this app" means it.

## Feature

- **Your assistant works over custom apps.** Open an installed app and the assistant button is in the corner. Open the panel, pick any of your agents that can use the app, and ask it to work in the app. You can also anchor the panel beside the app. If none of your agents can use the app yet, the panel tells you where to turn it on.
