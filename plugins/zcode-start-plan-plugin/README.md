# zcode-start-plan

Unofficial ZCode plugin that lets the agent **spend the free "ZCode Start Plan" trial quota** (the one that ships with a new Z.ai account) from the ZCode CLI.

The trial is desktop-app-only by design: its endpoint (`https://zcode.z.ai/api/v1/zcode-plan/anthropic`) authenticates with the shared ZCode JWT and requires an Aliyun captcha token on each request — the desktop app renders that captcha for you, a plain CLI cannot. This plugin re-implements the desktop wire protocol so the agent can delegate generation calls to your trial quota, including a one-time browser captcha bridge.

> [!WARNING]
> - **Unofficial.** Reverse-engineered from the ZCode desktop app (3.7.x). The protocol may break at any time.
> - **Risk control.** The captcha bridge drives the Aliyun web SDK outside a desktop-app context; heavy usage may trigger risk control on your Z.ai account.
> - **Delegated only.** The main conversation model is unchanged. Trial quota is spent by explicit `start_plan_generate` calls.

## Prerequisites

- ZCode CLI installed and logged in via OAuth: `zcode login` (writes the shared JWT to `~/.zcode/v2/credentials.json`).
- A Z.ai account with an active ZCode Start Plan trial (free with new accounts; check in the desktop app's plan page).
- A browser for the one-time captcha (the plugin opens a tab automatically).

## Install

```bash
zcode plugins add kingsword09/zcode-plugins
# then enable
zcode plugins enable zcode-start-plan@zcode-plugins
```

## What it provides

### MCP tools

| Tool | Purpose |
| --- | --- |
| `start_plan_status` | Check whether the account has an active trial; list usable models (e.g. `GLM-5.3`, `GLM-5-Turbo`) and plan states. |
| `start_plan_generate` | Delegated generation via the trial endpoint. Handles the captcha automatically: acquires a token first (opening a browser tab when the traceless pass is unavailable), attaches `X-Aliyun-Captcha-Verify-Param/Region`, retries `3007` (captcha rejected) with a fresh token, and backs off on `3008/3009/3010` (busy). |
| `start_plan_captcha` | Run the captcha bridge interactively (e.g. right after login, or after a 3007 failure) to stage a fresh token. |

### Slash command

- `/start-plan <prompt>` — checks entitlement, then delegates the prompt to `start_plan_generate`.

### Skill

`start-plan` — teaches the agent when to route a request to the trial quota and how to recover from captcha/busy failures.

## How it works

```
~/.zcode/v2/credentials.json ──AES-256-GCM──► zcodejwttoken (Bearer)
                                                  │
GET /api/v1/client/configs ──► captcha {region, prefix, sceneId}
                                                  │
local http://127.0.0.1 page ──► AliyunCaptcha.js ──► verify param
                                                  │
POST /api/v1/zcode-plan/anthropic/v1/messages
     Authorization: Bearer <jwt>
     X-Aliyun-Captcha-Verify-Param / -Region
```

- Credential decryption is self-contained (Node `crypto`): AES-256-GCM, key = sha256(`ZCODE_CREDENTIAL_SECRET` or the OS-derived fallback), format `enc:v1:iv.tag.ciphertext`.
- The captcha bridge is a one-shot localhost page mirroring the desktop renderer: `initAliyunCaptcha` with traceless verification preferred; a popup challenge is shown only when the traceless pass fails.
- Env overrides match the runtime: `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` / `ZCODE_ENV=test`, plus `ZCODE_DATA_BASE_DIR` for the credentials path.

## Troubleshooting

- **"No ZCode JWT token found"** — run `zcode login` (OAuth), not API-key login.
- **`3007` persists after retry** — complete the popup in the opened browser tab; corporate proxies blocking `o.alicdn.com` will break the SDK load.
- **`3008/3009/3010`** — free tier congestion; retry later.
- **Entitlement false** — the trial expired or was already consumed for the day (it resets daily).

## Development

```bash
bun install
bun run build     # bundles dist/mcp/server.js via tsdown (Node >= 24 target)
bun run typecheck # tsgo (TypeScript 7)
bun test
```

## License

MIT
