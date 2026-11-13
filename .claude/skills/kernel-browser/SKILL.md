---
name: kernel-browser
description: >
  Drive a real Chrome browser in the cloud with the `kernel` CLI — create a
  session, navigate, run Playwright against it, and capture screenshots — without
  touching the local desktop. Use when asked to "screenshot a page", "check how
  the web client renders", "QA the web app in a browser", "grab a screenshot for
  the PR", "test this URL", or whenever UI verification is needed but the Mac's
  desktop is busy or the run is headless. Covers session lifecycle, the live view
  URL, Playwright execution, screenshots, console/network telemetry, file
  upload/download, and cleaning up.
---

# Driving a browser with Kernel

[Kernel](https://www.kernel.sh) runs Chrome on a remote VM. The `kernel` CLI
creates a session, hands you a session ID, and every other command takes that ID.
Nothing runs on this machine — no window opens, no focus is stolen, no
screen-recording permission is needed.

That last part is why this skill exists. Flow's QA manual
(`.claude/agents/quality-assurance.md`) requires an idle desktop or explicit
operator authorization before local UI automation, because local automation
drives the *operator's* mouse and keyboard. Kernel sidesteps the whole
constraint: **use Kernel for anything web, and reserve local UI automation for
the macOS and iOS apps**, which can't run on a Linux VM.

What Kernel is good for here:

- Screenshotting `app.freeflow.im` (or `edge.freeflow.im`) for a PR
- Reproducing a web-client bug on a clean profile, with no cached session
- Checking rendering at a viewport size the Mac doesn't have
- Verifying a deploy actually shipped, from outside the local network

What it is **not** for: the macOS app, the iOS simulator, or anything needing
the local Flow dev server on `127.0.0.1:8787` — the VM can't reach this host.
Point it at a deployed URL, or expose a tunnel first.

---

## 0. Prerequisites

```sh
kernel --version          # installed via `brew install kernel/tap/kernel`
kernel auth status        # want: an API key or a logged-in user, and an API URL
kernel status             # Kernel's own service health
```

Auth is either an API key in `KERNEL_API_KEY` or `kernel login` (OAuth, opens a
browser). If `auth status` prints nothing useful, stop and ask the operator —
don't go hunting for keys in dotfiles, and never paste a key into a file, a
commit, a PR, or a Flow message.

Every command accepts `-o json` for parseable output and `--project <id-or-name>`
to scope to a project (or set `KERNEL_PROJECT`).

---

## 1. Create a session

```sh
kernel browsers create \
  --name flow-qa \
  --start-url https://app.freeflow.im \
  --viewport 1920x1080@25 \
  --timeout 600 \
  -o json
```

Read `session_id` out of the JSON — that's the handle for everything below.
`--name` gives you a stable alias, so `flow-qa` works anywhere `<id>` does.

Flags worth knowing:

| Flag | Use it when |
|---|---|
| `--start-url <url>` | You know the destination up front — saves a navigate step. |
| `--viewport WxH@fps` | Testing a specific size. Supported: `2560x1440@10`, `1920x1080@25`, `1920x1200@25`, `1440x900@25`, `1024x768@60`, `1200x800@60`, `1280x800@60`. |
| `-t, --timeout <secs>` | **Default is 60s** — far too short. Set 300–900 for real QA. The session is destroyed when it expires. |
| `-H, --headless` | No GUI. Faster, but `browsers computer` screenshots and the live view are useless. Prefer headful for QA. |
| `-s, --stealth` | The site blocks automation. Try this before assuming the page is broken. |
| `--profile-name <n>` | Reuse a saved logged-in profile (see §6). Add `--save-changes` to persist what the session does back to it. |
| `--telemetry=all` | You want console + network events (see §5). Opt-in — off by default. |
| `--tag KEY=VALUE` | Labelling a session so `browsers list --tag` can find it later. |

**Always set a timeout you can live with, and always clean up (§7).** Sessions
bill while they run.

## 2. Watch it live

```sh
kernel browsers view flow-qa
```

Prints a live-view URL — a browser window streamed to a web page. Give this to
the operator when you want a human to watch, take over, or log in by hand. The
same URL is in `browser_live_view_url` from `create`.

## 3. Drive the page with Playwright

This is the main tool. `playwright execute` runs TypeScript against the live
session with `page` already in scope; whatever you `return` comes back as JSON.

```sh
kernel browsers playwright execute flow-qa '
  await page.goto("https://app.freeflow.im", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});
  return { url: page.url(), title: await page.title() };
'
```

Notes that save a debugging cycle:

- **Wait before you screenshot.** A screenshot taken right after `create` catches
  a blank page. `networkidle` never settles on some pages, so wrap it in
  `.catch(() => {})` and move on rather than failing the run.
- Prefer role/text selectors (`page.getByRole("button", { name: /Send/i })`) over
  CSS — they survive Flow's class churn.
- Dismiss cookie/consent overlays first or they'll cover a third of the
  screenshot: `await page.getByRole("button", { name: /Reject all/i }).first()
  .click({ timeout: 10000 }).catch(() => {});`
- `--timeout <secs>` bounds the whole script.
- Quote the code in single quotes and use double quotes inside, so the shell
  leaves it alone.

## 4. Screenshots

```sh
kernel browsers computer screenshot flow-qa --to /tmp/flow-home.png
```

Writes a PNG of the **whole VM screen**, including Chrome's tab strip and
address bar — which is usually what you want for a PR, since it proves which URL
was loaded. Add `--x --y --width --height` to crop a region.

For a page-only or full-page-scroll image, use Playwright instead — but note it
writes inside the VM, so fetch it afterwards:

```sh
kernel browsers playwright execute flow-qa \
  'await page.screenshot({ path: "/tmp/full.png", fullPage: true }); return "ok";'
kernel browsers fs read-file flow-qa --path /tmp/full.png -o /tmp/full.png
```

Read the PNG back with the Read tool to confirm it shows what you claim before
attaching it to a PR or posting it in Flow. A screenshot of a spinner is not
evidence.

`kernel browsers replays start|stop|download <id>` records video of a session
when a still image can't show the bug (animation, ordering, a race).

## 5. When the page misbehaves

```sh
# Console + network events, if the session was created with --telemetry
kernel browsers telemetry stream flow-qa --categories console,network

# Raw browser/supervisor logs
kernel browsers logs stream flow-qa --source supervisor --supervisor-process chromium

# Hit an API through the browser's TLS fingerprint, cookies, and proxy
kernel browsers curl flow-qa https://app.freeflow.im/v1/health -i
```

`browsers curl` is the fast way to tell a **server** problem from a **client**
one: if curl-through-the-session returns the right JSON but the UI is empty, the
bug is in the web client.

`browsers process exec|spawn` and `browsers ssh <id>` get you a shell in the VM
if you need one.

## 6. Logged-in sessions

Flow's web client needs an account, and typing credentials into a Playwright
script is the wrong move. Two supported paths:

1. **Profiles** — `kernel profiles` saves a browser profile (cookies, storage).
   Log in **once** by hand through the live view on a session created with
   `--save-changes`, then reuse it: `--profile-name flow-user`. Subsequent runs
   start already authenticated.
2. **Managed auth** — `kernel auth connections`, for provider login flows Kernel
   drives itself.

Never hard-code a password or token in a skill, script, or PR. If a run needs
credentials it doesn't have, create the session, print the live-view URL, and
ask the operator to log in.

## 7. Clean up — always

```sh
kernel browsers delete flow-qa
kernel browsers list            # confirm: "No running browsers found"
```

Sessions bill until they're deleted or time out. Delete as soon as the last
screenshot is captured, even when the run failed. `browsers list` (add
`--tag`, `--query`, `--status all`) finds strays from earlier runs.

---

## The whole loop, end to end

```sh
SID=$(kernel browsers create --name flow-qa \
        --start-url https://app.freeflow.im \
        --viewport 1920x1080@25 --timeout 600 -o json | jq -r .session_id)

kernel browsers playwright execute "$SID" '
  await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});
  await page.getByRole("button", { name: /Reject all/i }).first()
    .click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return await page.title();
'

kernel browsers computer screenshot "$SID" --to /tmp/flow-home.png
kernel browsers delete "$SID"
```

Then Read `/tmp/flow-home.png`, check it shows the thing under test, and attach
it to the PR — Flow PRs carry screenshots for every client with visible impact.
