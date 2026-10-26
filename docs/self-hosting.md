# Self-hosting

LearnHarness runs as one Next.js server on a machine you own, for one person. You reach it from your other devices through a Cloudflare Tunnel on your own subdomain, through Tailscale, or both. Nothing listens on your network directly: the server binds to `127.0.0.1`, and the tunnel is the only way in.

Two locks stand in front of the app:

1. **The tunnel's own access control.** Cloudflare Access for the tunnel; tailnet membership for Tailscale.
2. **The app's passphrase.** Every page and API request needs a session cookie. It is a 30-day, `HttpOnly`, `Secure`, `SameSite=Strict` cookie, and state-changing requests from other sites are refused.

Keep both. The server can spend your ChatGPT plan and your API keys.

## 1. Install and build

Requirements: Node 26, npm, and Google Chrome or Chromium on the server. Demo verification runs the teacher's interactive demos in a headless Chrome. Set `CHROME_PATH` if Chrome is not in a standard location.

```bash
git clone https://github.com/amosblomqvist/learnharness.git
cd learnharness
npm ci
npm run build
```

## 2. Set the passphrase

```bash
npm run set-passphrase
```

This writes `data/credentials/access.json` (mode `0600`): a scrypt hash plus a random session-signing key. Run it again at any time to change the passphrase, which also signs every browser out. **Sign out** at the bottom of the sidebar ends just the current browser's session. Until a passphrase exists, the app refuses every request and the login page explains what to run.

## 3. Run the server

```bash
npm start            # next start -H 127.0.0.1 (port 3000)
```

To keep it running across reboots, use a systemd user service, `~/.config/systemd/user/learnharness.service`:

```ini
[Unit]
Description=LearnHarness
After=network-online.target

[Service]
WorkingDirectory=%h/learnharness
ExecStart=/usr/bin/npm start -- -p 3000
Restart=on-failure
# Optional: keep data outside the checkout.
# Environment=LH_DATA_DIR=%h/.local/share/learnharness

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now learnharness
loginctl enable-linger "$USER"   # keep user services running while logged out
```

## 4a. Cloudflare Tunnel on your subdomain

```bash
cloudflared tunnel login
cloudflared tunnel create learnharness
cloudflared tunnel route dns learnharness learn.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: learnharness
credentials-file: /home/YOU/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: learn.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

```bash
cloudflared tunnel run learnharness   # or: sudo cloudflared service install
```

Then put the hostname behind **Cloudflare Access**:

1. In Zero Trust → Access → Applications, add a self-hosted application for `learn.example.com`.
2. Add an Allow policy for your email address only.

Cloudflare then authenticates you before any request reaches your machine. The app's passphrase is the second lock.

## 4b. Tailscale

```bash
tailscale serve --bg 3000
```

The app is then served over HTTPS at `https://<machine>.<tailnet>.ts.net`, reachable only from devices in your tailnet. Do not use `tailscale funnel`, which makes it public.

Both routes give you HTTPS, which the browser needs for the secure session cookie and for dictation (microphone access).

## 5. Connect your ChatGPT plan

Open **Settings → Providers → ChatGPT → Connect**, then **Continue with ChatGPT**.

OpenAI's sign-in for open-source, locally hosted apps only redirects to `http://127.0.0.1:<port>/auth/callback`. That address points at the device you are browsing from, not the server, so sign-in uses a paste-back step:

1. Click **Open ChatGPT sign-in** and approve LearnHarness in the new tab.
2. ChatGPT sends that tab to a `http://127.0.0.1:…/auth/callback?code=…` page that does not load. This is expected.
3. Copy that full address from the address bar, paste it into the dialog, and press **Finish sign-in**.

The server checks the pasted address against the sign-in it started (the one-time `state`), then exchanges the code using its private PKCE verifier. The verifier never leaves the server. A sign-in expires after 3 minutes; an address that does not match is refused and the sign-in stays open for another try. If the page reloads mid-sign-in (common on a phone when switching tabs), the ChatGPT row shows **Finish sign-in** and reopens the paste step.

Tokens and refresh handles are stored in `data/credentials/chatgpt-credentials.json` (mode `0600`). Only the server reads them; the browser only ever sees account status.

When the plan's usage limit is hit, a banner shows when it resets. Until then background work (graph extraction, research, paper tracing) pauses, and messages you send yourself still go out. Background work resumes on its own at the reset. The plan's live usage shows in **Settings → Providers → ChatGPT**, and under the composer whenever a ChatGPT model is selected.

GitHub Copilot and Grok use device-code sign-in instead. The dialog shows a code, and **Open sign-in page** opens the provider's page in a new tab.

## 6. Research sources (optional)

The researcher sub-agent searches and reads the web for the teacher. Configure it in **Settings → Providers → Connectors** (these values show in full; they are addresses and research-source keys):

- **SearXNG**: if you run a SearXNG instance (for example in Docker), set **SearXNG** to its base URL, such as `http://127.0.0.1:9180`. It must allow the JSON format: `search.formats` in its `settings.yml` must include `json`. When it's set, it's preferred over Tavily and Brave. It's local and free, and no API key is needed.
- **alphaXiv**: create a key under alphaXiv Settings → API Keys and paste it into **alphaXiv**. Research jobs then also get alphaXiv's paper tools: paper search, reports and full text, questions answered from a paper's PDF, and its code. Only read tools are exposed; nothing changes your alphaXiv library.

## 7. Install on your phone and turn on notifications

LearnHarness installs as an app from the browser:

- **iPhone / iPad (Safari):** Share → **Add to Home Screen**, then open LearnHarness from the home screen. iOS only delivers notifications to the installed app, not to a Safari tab.
- **Android (Chrome):** menu → **Install app** (or **Add to Home screen**).

Then open **Settings → Notifications** on that device and turn on **Notifications on this device**. You get:

- a daily digest of what is waiting across your topics, at the time you set (server time), only when something is;
- an alert when the ChatGPT plan limit is hit, and another when it resets.

**Send a test** checks delivery. Notifications travel through the browser vendor's push service (Apple, Google or Mozilla). This needs outbound access only; the tunnel needs no extra configuration. Each device is turned on separately.

## 8. Learning from a paper

On **+ Topic**, give an arXiv id or link (for example `1706.03762` or `https://arxiv.org/abs/1706.03762`). A background tracer reads the paper and follows its citations, at most 2 levels deep and 10 papers, to where its core methods and ideas come from. That takes a minute or two. It produces an outline of concepts, each with the papers it comes from, and mapping then probes what you already know against that outline. With an alphaXiv key the tracer uses alphaXiv's paper tools; without one it reads arXiv PDFs directly.

## Files

| Path | What |
|---|---|
| `data/credentials/access.json` | passphrase hash + session key |
| `data/credentials/chatgpt-credentials.json` | ChatGPT OAuth credentials |
| `data/credentials/{github-copilot,xai}-credentials.json` | Copilot / Grok OAuth credentials |
| `data/credentials/push.json` | push keys (VAPID) and notification devices |
| `data/topics/` | topic maps and their evidence logs |
| `auth.json` (repo root, or `LH_AUTH_FILE`) | API keys entered in Settings → Keys |
| `data/` | chats, graph, jobs, settings |

`LH_DATA_DIR` moves everything under `data/`. Back up `data/`. Do not commit or share `data/credentials/` or `auth.json`.
