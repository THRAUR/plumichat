# Installing PlumiChat

Works on **Linux**, **macOS** and **Windows**. Only Node 22+ and the Anthropic Agent
SDK are required; everything else is optional and PlumiChat tells you at startup
what it could not find.

> **Platform support, honestly:** verified on Linux (including WSL2) and on macOS
> (Apple silicon, Node 22). Windows is written against documented behaviour and
> isolated in `server/platform.js`, but has **not** been run on real hardware. If you
> hit something, an issue with the output of the startup banner is genuinely useful.

---

## 1. Requirements

| | Needed | Notes |
|---|---|---|
| **Node.js** | 22.9 or newer | `node --version`. There is no build step and no transpiler. |
| **Anthropic access** | yes | An `ANTHROPIC_API_KEY`, or sign the bundled CLI into a Claude subscription. |
| **git** | recommended | Needed for Operations and engine updates. |

### Optional tools, and what each one buys you

Install none of these and PlumiChat still works — the features simply report
themselves unavailable.

| Tool | Unlocks | Install |
|---|---|---|
| **pandoc** | `.docx` and `.pptx` export | `apt install pandoc` · `brew install pandoc` · `winget install JohnMacFarlane.Pandoc` |
| **Chrome/Chromium** | `.pdf` export on clients that cannot print | Any Chrome, Chromium or Edge. Override with `CHROME_BIN`. |
| **tmux** | terminal sessions that survive a server restart | `apt install tmux` · `brew install tmux` · *(not available on Windows)* |
| **bubblewrap** (Linux) | member account confinement | `apt install bubblewrap` |
| **pm2** | the in-app Restart button, and boot persistence | `npm i -g pm2` |
| **C/C++ build tools** | the terminal panel (`node-pty` is a native module) | `build-essential` · Xcode CLT · VS Build Tools |
| **nvidia-smi** | GPU figures on the machine card | Comes with the NVIDIA driver. WSL uses the Windows driver's copy, no install needed |
| **LibreHardwareMonitor** (Windows, WSL) | CPU temperature on the machine card | See [CPU temperature on Windows and WSL](#cpu-temperature-on-windows-and-wsl-optional) |
| **lm-sensors** (Linux) | CPU temperature, when no sensor shows up by itself | `apt install lm-sensors`, then `sudo sensors-detect` |

`.xlsx` export needs nothing — it is built in.

---

## 2. Install

```bash
git clone https://github.com/THRAUR/plumichat.git
cd plumichat
npm install
cp .env.example .env      # optional: every value has a default
npm start
```

Open **http://localhost:3002** and create the owner account.

To update later, use `git pull && npm ci` — `npm ci` installs straight from the
lockfile and will not leave local changes that block the next pull.

If `npm install` warns about **node-pty**, that is fine — it is an *optional*
dependency and you lose the terminal panel and nothing else. Two different warnings
mean two different things:

**"install scripts not yet covered by allowScripts"** — recent npm blocks packages
from running build scripts by default, as supply-chain protection. `node-pty` is a
native module, so without its build step it cannot load. Approve it if you want the
terminal:

```bash
npm install-scripts approve node-pty   # then:
npm rebuild node-pty
```

**A compile error** — you are missing build tools. See the table above
(`build-essential` on Linux, `xcode-select --install` on macOS, VS Build Tools on
Windows), then `npm rebuild node-pty`.

### What you should see

```
  PlumiChat
  URL         http://localhost:3002
  Reachable   this machine only
  Sign-in     NOT SET UP - open the URL to create the owner account
  Workspace   /home/you/projects
  Platform    Linux

  Not available here (everything else is on):
    - exportPdf: No Chrome/Chromium found. Install one, or set CHROME_BIN.
    - push: No VAPID keypair yet. It is generated and written to .env the first time push is enabled.
```

That second block is the whole point: whatever is missing is named at startup, not
discovered later when a button fails. The same information is available live at
`GET /api/capabilities`.

---

## 3. Per-platform notes

### Linux

The reference platform. Everything works.

For **member accounts** install bubblewrap (`apt install bubblewrap`). Without it,
member turns refuse to run rather than run unconfined — see
[SECURITY.md](SECURITY.md).

### macOS

Verified end to end: clone, install, boot, create the owner account, use it.

- **Member confinement works out of the box** — the built-in seatbelt sandbox
  (`/usr/bin/sandbox-exec`) is detected automatically, nothing to install.
- Listening-socket discovery for **Sites** uses `lsof`, which macOS ships.
- A clean Mac has no `pandoc` and no `tmux`, so document export and terminal
  persistence report themselves unavailable until you add them:
  `brew install pandoc tmux`.
- `shutdown` needs privileges, so the machine power controls will report a failure
  unless you have arranged for that. Nothing else is affected.
- **Do not put `~/.claude` on an external volume.** If you sign the bundled CLI
  into a Claude subscription rather than using an API key, macOS stores that login
  in the **login Keychain** (service `Claude Code-credentials`), falling back to
  `~/.claude/.credentials.json` when the Keychain refuses. Point `~/.claude` at a
  drive that is unplugged — or at exFAT, which cannot hold mode `0600` — and
  neither store is writable. `/login` then reports *"Login successful"* and the
  very next message says *"Not logged in"*, under a header reading *"API Usage
  Billing"* even on a Max account. Every symptom points away from the cause.
  One command settles it: `test -d ~/.claude/ && echo ok || echo UNREACHABLE`.

### Windows

Chat, files, exports, notifications and Operations work. Two real limitations:

- **No member accounts.** Windows has no sandbox PlumiChat can confine a member
  with, so member turns are refused rather than run unconfined. Run Windows
  installs as **owner-only**.
- **No `tmux`**, so a terminal session ends when the server restarts. The terminal
  itself works (PowerShell) as long as `node-pty` built.

`node-pty` needs the [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)
("Desktop development with C++"). Skip them and you skip the terminal panel.

### WSL2

Detected automatically and treated as Linux, with one difference: the machine power
controls reach the **Windows host** through `shutdown.exe`, because the distro is
not the machine.

The machine card follows the same logic: Wi-Fi is read from Windows' `netsh`, and
the GPU through the Windows driver's `nvidia-smi` in `/usr/lib/wsl/lib`. CPU, RAM
and network figures are the **Linux VM's** share of the machine. The CPU
temperature is out of reach from inside the VM; see
[CPU temperature on Windows and WSL](#cpu-temperature-on-windows-and-wsl-optional).

---

## 4. Reaching it from your phone

<img src="img/chat-phone.png" alt="PlumiChat on a phone, mid-turn" width="240" align="right">

The web app is built for a phone — installable to the home screen, no address bar.
But **do not port-forward it from your router**. See [SECURITY.md](SECURITY.md) for
why. Two good options:

### Tailscale (recommended)

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3002
```

Keeps the app on loopback, gives you real HTTPS on a `*.ts.net` name, and never
touches the public internet. Passkeys and push both work because it is a proper
secure context.

### A reverse proxy you control

Terminate TLS in Caddy or nginx and proxy to `127.0.0.1:3002`. Forward
`X-Forwarded-Proto` and `X-Forwarded-Host` — PlumiChat derives the WebAuthn
relying-party id and invite links from them.

```
plumichat.example.com {
    reverse_proxy 127.0.0.1:3002
}
```

### Install it to the home screen

Open the HTTPS address, then **Share → Add to Home Screen** (iOS) or
**Install app** (Android/desktop Chrome).

> iOS snapshots the icon **and** the name at install time. If you rebrand later, the
> installed copy keeps the old ones until it is removed and re-added.

---

## 5. Keeping it running

### Linux / macOS — pm2

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs     # edit `cwd` in that file first
pm2 save && pm2 startup            # survive a reboot
```

Set `PM2_APP_NAME=plumichat` in `.env` to enable the in-app Restart button.

> Run `pm2 save` from a **plain login shell**. It snapshots the entire environment
> of whoever started the app and replays it on every restart forever — including,
> if you start it from inside a Claude Code session, that session's markers. The
> server scrubs those at boot, but a clean dump is better than a scrubbed one.

### Windows

Use [NSSM](https://nssm.cc/) or a Scheduled Task set to "run whether user is logged
on or not". PM2's Windows startup support is unreliable.

---

## 6. Configuration

Every variable is optional. `.env.example` is the annotated reference; this is the
summary.

### Core

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3002` | Listen port. |
| `HOST` | `127.0.0.1` | Listen address. **Anything else requires `AUTH_USER`/`AUTH_PASS`** or the server refuses to start. |
| `WORKSPACES_ROOT` | `~/projects` | The one root every path is contained inside. |
| `DATA_DIR` | `./data` | Accounts, settings, Operations tasks, patches, caches. |
| `ANTHROPIC_API_KEY` | — | Passed to the SDK. Omit if the bundled CLI is signed into a subscription. |
| `SESSION_SECRET` | generated | Signs session cookies; written to `.env` on first boot. Changing it signs everyone out. |
| `AUTH_USER` / `AUTH_PASS` | — | HTTP Basic lifeline → owner. The recovery path, and required for a non-loopback bind. |

### Models

| Variable | Purpose |
|---|---|
| `CLAUDE_MODEL` | Default model when a turn names none. |
| `TITLE_MODEL` | Generates conversation titles. |
| `OPS_MODEL` | Model for Operations tasks. |

### Limits

| Variable | Default | Purpose |
|---|---|---|
| `PLUMI_MAX_RUNS` | `5` | Concurrent turns, all users. Each is a ~340 MB process. |
| `PLUMI_MAX_RUNS_PER_USER` | `2` | Concurrent turns per account. |
| `PLUMI_ASK_TIMEOUT_MS` | 30 min | How long an unanswered permission card blocks a turn. |
| `PLUMI_BACKGROUND_WAIT_MS` | 15 min | Silence allowed while a finished turn closes down; longer and it is ended. |
| `PLUMI_BACKGROUND_MAX_MS` | 60 min | How long background work may keep a turn open after its reply. |
| `PLUMI_INVITE_TTL_DAYS` | `7` | Invite-link lifetime. |

### Notifications

| Variable | Purpose |
|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Generated and saved to `.env` on first use. |
| `VAPID_SUBJECT` | **Set a real `mailto:` or `https:` contact.** Apple's push service may reject a bogus one. |

### Optional integrations

| Variable | Purpose |
|---|---|
| `CHROME_BIN` / `PANDOC_BIN` | Override tool discovery. |
| `PM2_APP_NAME` | Which PM2 process the Restart button targets. Unset = no button. |
| `PLUMI_TERMINAL_DIRS` | Extra folders in the terminal picker: `Label=/path` pairs, comma-separated. |
| `PLUMI_DESIGN_SYNC_DIR` | A folder the terminal can jump into with `claude` running. Unset = button hidden. |
| `PLUMI_DOC_VENV_BIN` | A venv `bin/` prepended to each turn's PATH, for the document Skills. |
| `OPS_RUNNER` | `sdk` (default) or `native`. See [OPERATIONS.md](OPERATIONS.md). |
| `OPS_SIGNALS` | Production error digests for scheduled runs. See `ops-signals.example.json`. |
| `PLUMI_MEMORY_URL` / `PLUMI_MEMORY_KEY` | A Supermemory server for long-term memory. See below. |
| `PLUMI_MEMORY_NOTE` | One line shown in Settings → Memory about where conversation text is processed. |
| `PLUMI_MEMORY_RECALL_MS` | Ceiling on the per-turn memory lookup (default 2500). |
| `PLUMI_SENSORS_URL` | Where the machine card asks LibreHardwareMonitor for the CPU temperature. Default on Windows/WSL: `http://127.0.0.1:8085/data.json`; `off` disables it. |
| `PLUMI_NET_TARGETS` | `host:port` pairs the card's internet check times (default `1.1.1.1:443,8.8.8.8:443`); `off` disables the check and the connection grade. |
| `PLUMI_MACHINE_NAME` | The name on the machine card. Default: the server's time zone, e.g. "Paris, France". |
| `PLUMI_IMAGE_DIR` | A stable-diffusion.cpp install, to make pictures locally. Unset = no image tool. See below. |
| `PLUMI_IMAGE_SCRATCH` | Where the generator writes before the file is moved into the account's gallery. Default: `<PLUMI_IMAGE_DIR>/out`. |
| `PLUMI_IMAGE_TIMEOUT_MS` | Ceiling on one picture (default 300000). |
| `PLUMI_IMAGE_MIN_VRAM_MB` | Refuse rather than load a model when the card has less free than this (default 4500). |
| `PLUMI_IMAGE_KEEP_DAYS` / `PLUMI_IMAGE_KEEP_MB` | How long and how much of each account's gallery to keep (default 30 days / 2048 MB). |
| `PLUMI_IMAGE_ENGINE` | `auto` (default), `server` or `cli`. `auto` keeps the model loaded between pictures when it can and falls back on its own when it cannot; `cli` turns that off, and with it the studio page. |
| `PLUMI_IMAGE_PORT` | Loopback port for the resident engine (default 1234). Change it if something else already listens there. |
| `PLUMI_IMAGE_IDLE_MS` | Unload the model after this long with no pictures (default 900000 — 15 minutes). |
| `PLUMI_IMAGE_BOOT_MS` | How long to wait for the engine to finish loading before giving up on it (default 240000). |
| `PLUMI_IMAGE_FORMAT` | `webp` (default), `png` or `jpeg`. |
| `PLUMI_IMAGE_QUALITY` | Compression quality, 50–100 (default 92). Ignored for PNG. |
| `PLUMI_GPU_LEASE` | The file another program writes to borrow the whole card, e.g. for a Blender render (default `~/.cache/plumi/gpu-lease.json`). While it is live, pictures pause and the engine unloads. |

### Making pictures locally (optional)

If the box has an NVIDIA card with about 6 GB of VRAM free, it can generate images
in the chat with no API and no cost. PlumiChat drives
[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp).

1. Download a release for your machine and unpack it, so the binaries are at
   `<dir>/bin/sd-cli` and `<dir>/bin/sd-server` (`.exe` on Windows, and see the WSL
   note below). Both ship in the same release; `sd-server` is optional but it is
   what makes pictures fast — see *Keeping the model loaded* below.
2. Put a model's files under `<dir>/models/`. The built-in default expects
   **Z-Image Turbo** — 6B parameters, 8 steps, happy on an 8 GB card:

   | File | From |
   |---|---|
   | `z_image_turbo-Q4_K.gguf` | `leejet/Z-Image-Turbo-GGUF` |
   | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | `unsloth/Qwen3-4B-Instruct-2507-GGUF` |
   | `ae.safetensors` | `Comfy-Org/z_image_turbo`, under `split_files/vae/` |

3. Set `PLUMI_IMAGE_DIR` to that folder and restart. The startup banner says what is
   still missing if anything is; `GET /api/capabilities` has the same answer.

Any other model is a `presets.json` in that folder, no code change — copy
`imagegen.config.example.json` from the repo root. Its `args` are passed to the
binary verbatim, which is what lets a model with a different text encoder (`--t5xxl`
and `--clip_l` rather than `--llm`) work without one.

**Under WSL**, use the **Windows** build. Upstream ships no Linux CUDA binary, so on
a WSL box with an NVIDIA card the Windows `sd-cli.exe` is the one with CUDA in it —
PlumiChat launches it like any other child process. Keep the install on a Windows
drive (`/mnt/c/...`): a Windows program cannot usefully write into the Linux
filesystem, so the picture is written on its side and moved across afterwards.

Pictures land in a `.plumi-images` folder inside the account's own home, which is
where the file picker, the thumbnails and the Download box can all reach them, and
nowhere else — a member's pictures are inside their home like everything else of
theirs. The model never gets to name a path.

#### Keeping the model loaded

`sd-cli` loads every weight file on every run, so most of the wait is not drawing.
Measured on one 8 GB card with Z-Image Turbo at 8 steps:

| | Per picture |
|---|---|
| `sd-cli`, one run per picture | **44–46 s**, of which ~30 s is loading 6.4 GB |
| `sd-server` resident, already loaded | **17 s** |
| First picture after the server starts | ~46–53 s (that one pays the load) |

So PlumiChat starts `sd-server` on loopback, keeps it, and unloads it again after
`PLUMI_IMAGE_IDLE_MS` of quiet — it holds about 4.4 GB of the card while warm and
gives all of it back when the timer fires. The engine is **probed, never assumed**:
if it does not answer, the reason is logged once and every picture still gets made
by `sd-cli`, one load at a time. `PLUMI_IMAGE_ENGINE=cli` forces that.

Output is **webp at quality 92** by default rather than PNG. A 1216×832 picture is
roughly 150–300 KB instead of 2 MB, which is most of the remaining wait if you are
reading over a phone connection from the other side of the world.
`PLUMI_IMAGE_FORMAT=png` restores lossless.

**Under WSL this needs `networkingMode=mirrored`**, because the engine is a Windows
process and without it a Windows-side `127.0.0.1` listener is not reachable from
Linux. Put this in `%UserProfile%\.wslconfig` and run `wsl --shutdown`:

```ini
[wsl2]
networkingMode=mirrored
```

Without it nothing breaks — the startup banner says why the engine is off and
pictures take the slow path.

#### The picture studio (owner only)

`sd-server` has a full web UI compiled into it — every sampler, scheduler, CFG and
img2img knob the binary supports. PlumiChat serves it at **`/sdui`** behind the same
login, owner-only, and there is a *Picture studio* row in the drawer to open it. It
is an upstream page, so: it is desktop-shaped, and pictures made there come back as
bytes in the browser — they do **not** land in an account's gallery or the download
tray. The Pictures panel is the everyday door; this is the knobs-and-dials one.

Nothing serves it unless `sd-server` is present and `PLUMI_IMAGE_ENGINE` is not
`cli`; `GET /api/capabilities` reports `imageStudio` either way, with a reason.

### Long-term memory (optional)

PlumiChat can remember across conversations: preferences, decisions, the people and
projects someone mentions. It does this through a [Supermemory](https://github.com/supermemoryai/supermemory)
server, either one you run or the hosted API. Both speak the same REST API.

**Hosted:** create a key at `console.supermemory.ai`, then set
`PLUMI_MEMORY_URL=https://api.supermemory.ai` and `PLUMI_MEMORY_KEY`. Conversation
text is then processed by Supermemory's cloud.

**Self-hosted:** `npx supermemory local` (or the `supermemory-server` binary from
their GitHub releases) runs the whole engine on your machine. Worth knowing before
you do:

- **It needs a model for extraction.** Set one of `OPENAI_API_KEY` (any
  OpenAI-compatible endpoint via `OPENAI_BASE_URL`, including Ollama or OpenRouter),
  `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `GROQ_API_KEY` in *its* environment,
  not PlumiChat's. The text of every remembered turn goes to that model.
- **Pick the embedding model before the first memory is stored.** The default is
  English-only; for other languages set `SUPERMEMORY_EMBEDDING_MODEL` (a local
  multilingual model such as `Xenova/multilingual-e5-base` with
  `SUPERMEMORY_EMBEDDING_DIMENSIONS=768`, or a remote one). The dimensions are locked
  into the store.
- **It listens on every interface, and it trusts every request whose `Host` is
  localhost, key or not** (v0.0.8). Keep port 6767 closed to the network. On Linux,
  `scripts/supermemory/bind-loopback.c` pins it to loopback without root. Start it
  with a clean environment: it reads `PORT` before `SUPERMEMORY_PORT`, so a shell
  that exports PlumiChat's `PORT` will make it fight PlumiChat for that port.
- **Budget the RAM:** about 1.2 GB at idle, more while a local embedding model is
  loaded. The self-hosted licence caps the store at 10,000 documents; PlumiChat uses
  one per conversation.
- **Member accounts** get memory from a self-hosted server only under the Linux
  (bubblewrap) sandbox, the one where a member's shell has been verified unable to
  reach it. Elsewhere members can use the hosted API only; owners and admins are
  unaffected. Keep the server's data directory where a member's
  shell cannot read it: the default `~/.supermemory` is hidden automatically.

Then set `PLUMI_MEMORY_URL` (e.g. `http://127.0.0.1:6767`) and `PLUMI_MEMORY_KEY` (the
key it prints on first boot), and restart PlumiChat. The boot log says whether the
server answered. Each account then has a switch under Settings → Memory: on by
default for the owner, off for everyone else.

### CPU temperature on Windows and WSL (optional)

Windows only shows the CPU temperature to administrators, and a WSL VM cannot see
the sensor at all. The machine card therefore asks
[LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)
(free, open source), which runs elevated and serves its readings locally. It needs
someone at the PC once, because it asks for admin rights:

1. From its [releases page](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases),
   download **`LibreHardwareMonitor.zip`**. The `LibreHardwareMonitor.NET.10.zip`
   beside it needs a separate .NET runtime; this one runs on any Windows 10 or 11.
   Unzip it into a new folder of its own that will stay put, e.g.
   `C:\LibreHardwareMonitor`.
2. Double-click `LibreHardwareMonitor.exe` and accept the admin prompt; it asks by
   itself. With file extensions hidden, pick the file whose type is *Application*:
   two settings files beside it carry almost the same name.
3. When it asks **"PawnIO is not installed, do you want to install it?"**, click
   **OK**. PawnIO is the driver it reads the CPU through. Without it the program
   still runs and answers, but lists no CPU temperature, and the card says so.
4. **Options → Remote Web Server → Run** (port 8085). Then, in **Options**, tick
   **Run On Windows Startup**, **Start Minimized** and **Minimize On Close**, so it
   comes back after a reboot and closing its window does not stop it.

Within a minute the card shows the CPU temperature and power on its own; nothing
needs a restart. Windows should not ask about the firewall: the web server runs
inside Windows' own HTTP service, and the card reads it from the same PC. Keep port
8085 closed to the network, because that server has no password by default and
accepts fan-control commands.

Under WSL this needs **mirrored networking** (`networkingMode=mirrored` under
`[wsl2]` in `%UserProfile%\.wslconfig`), so that `127.0.0.1` inside the VM reaches
Windows. In NAT mode `127.0.0.1` stays inside the VM: point `PLUMI_SENSORS_URL` at
the Windows host's address (the VM's default gateway), and let the VM through
Windows Firewall on port 8085.

### Two-copy deploy (advanced, off by default)

Only for the setup where you **edit** one checkout and **serve** a different one.
Leave unset and the Deploy surface reports itself unavailable.

| Variable | Purpose |
|---|---|
| `PLUMI_LIVE_CLONE` | The served checkout. Setting it enables Deploy. |
| `PLUMI_DEV_REPO` | The checkout you edit. Defaults to the one running. |
| `PLUMI_ENGINE_STAGING` | Scratch dir for staged engine updates. Defaults to a temp dir. |

---

## 7. Troubleshooting

**"PlumiChat refused to start."**
`HOST` is not loopback and no authentication is configured. Either unset `HOST`, or
set `AUTH_USER` and `AUTH_PASS`. This is intentional — see [SECURITY.md](SECURITY.md).

**A feature is missing from the menu.**
It is gated on a capability this machine lacks. Check the startup banner, or
`GET /api/capabilities`, for the specific reason.

**No terminal panel.**
`node-pty` did not build. Either npm blocked its install scripts
(`npm install-scripts approve node-pty`) or you are missing build tools — see
section 2. Then `npm rebuild node-pty` and restart.

**`npm start` fails with `node: .env: not found`.**
You are on Node older than 22.9, which lacks `--env-file-if-exists`. Either upgrade
Node, or run `node server/index.js` directly, or just `touch .env`.

**Signing in says "Login successful", then "Not logged in" on the next message.**
The login cannot be persisted. On macOS that is almost always `~/.claude` pointing
at an unmounted or exFAT volume — see the macOS notes in section 3; the same
happens over SSH or in a daemon context where the login Keychain is not writable.
The header will read "API Usage Billing" even on a subscription, which is the
label shown when no credential is readable — not evidence of an API key.

**The header says "API Usage Billing" but you are on Pro/Max.**
Something outranks your subscription login. The order, highest first: cloud
provider credentials (Bedrock/Vertex) → `ANTHROPIC_AUTH_TOKEN` →
`ANTHROPIC_API_KEY` → an `apiKeyHelper` in a `settings.json` → your subscription.
`/status` inside the CLI names the active source. Note that PlumiChat's terminal
inherits the **server's** environment, so unsetting a variable in a fresh shell
changes nothing until you restart the server from a clean one.

**`git pull` says "local changes to package-lock.json would be overwritten".**
`npm install` rewrites the lockfile on some npm versions, so your checkout differs
from the repo before you have changed anything. Discard it and pull:

```bash
git restore package-lock.json
git pull
npm ci          # installs exactly what the lockfile says, and never rewrites it
```

Use `npm ci` rather than `npm install` when you are just consuming the project;
it is faster, reproducible, and avoids this every time you update.

**Passkeys / notifications unavailable.**
They need a secure context. Use `localhost`, or put HTTPS in front.

**Export produces an error.**
`.docx`/`.pptx` need pandoc; `.pdf` also needs Chrome/Chromium. `.xlsx` needs
nothing and should always work.

**Members cannot start a turn.**
No OS sandbox. Install bubblewrap on Linux; on Windows, run owner-only.
