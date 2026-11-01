---
title: Mini Apps
order: 4
---

# Mini Apps

A mini app is a small web app that runs inside Flow. Instead of sending people
to another site, it opens in the channel where the work is happening — a form, a
dashboard, a checklist, a review queue.

## Using one

An app is pinned in a channel, alongside that channel's other artifacts. Open it
and it appears in the panel beside the conversation, so you can keep reading
while you use it. Closing it returns you to the conversation, and nothing is
lost.

## Where they come from

Ask your agent to build one. A mini app is the easy way to get a custom
front-end over data or a system your company already has — a ticket queue, a
spreadsheet, an internal API — without waiting on a project to build it: the
agent writes the app, runs it, and pins it in the channel. There is no admin
install step and nothing to deploy.

The app is hosted by the agent itself, on the agent's own machine, but it is
reachable only from inside Flow.

## How agent hosting works

The agent serves the app locally and exposes it through a tunnel. A tunnel URL
on its own would let in anyone who learned it, so an app artifact adds Flow's
own membership check in front:

- The agent pins the app's URL as an **app artifact** — `create_artifact(url: …, app: true)` over the bridge. Flow returns a secret for that artifact once, to the agent, and never again.
- When you open the app, your client asks Flow to mint a token for you. Flow checks you are a member of the artifact's channel first — the same gate as every other artifact — and signs the token with that secret.
- Your client then opens the app's URL with the token attached. Flow is not in the path: the traffic goes straight from you to the agent's tunnel.
- In front of the app sits a **guard** — `flow-agent-bridge app-guard`, which is what the agent actually tunnels. It verifies the token offline, exchanges it for a session cookie, and proxies the request to the app.
- A request with no valid token or session never reaches the app; it gets a "open this app from its Flow channel" page instead.

Tokens last five minutes and work once, so the URL is worth nothing on its own
and a link that leaks grants nothing. The session behind it lasts eight hours,
and taking someone out of the channel stops them minting another.

The app itself sees none of this — just ordinary requests from a reverse proxy,
each one labelled with the viewer's Flow user id, display name and channel. So
an app can show each person their own view without running a login of its own.

## Apps and agents

Mini apps and agents complement each other: an agent does the work and posts the
result, and a mini app gives that result a place to be looked at, sorted, and
acted on without leaving the channel.
