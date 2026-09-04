// PM2 process definition — OPTIONAL. PlumiChat runs fine with `npm start`; this is
// for keeping it up across reboots on an always-on machine (Linux/macOS; on Windows
// prefer NSSM or a Scheduled Task).
//
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     # survive a reboot
//   pm2 restart plumichat
//
// Set `cwd` below to wherever you cloned this, or delete the line to use the
// directory you run pm2 from.
//
// ── The dump.pm2 environment trap ────────────────────────────────────────────
// `pm2 save` snapshots the WHOLE ENVIRONMENT of whoever started the app into
// ~/.pm2/dump.pm2 and replays it on every later restart and on machine boot. If you
// first start the app from inside a Claude Code session, that session's markers
// (CLAUDECODE=1, CLAUDE_CODE_SESSION_ID, TMPDIR=/tmp/claude-<uid>, …) get baked in
// and leak into every agent turn the server spawns — which breaks turns in
// confusing ways, because the agent CLI sees itself nested inside another CLI.
// server/index.js scrubs those variables at boot so a stale dump cannot poison
// turns, but the cleanest fix is to run `pm2 save` from a plain login shell.
//
// ── Why there are almost no variables below ──────────────────────────────────
// Secrets belong ONLY in .env, which `node --env-file=.env` loads at startup. Do
// not move them here: `pm2 save` would copy every value into dump.pm2, i.e. a
// second, unencrypted, un-gitignored copy of your secrets. Note also that when a
// variable is set in BOTH the real environment and .env, the REAL ENVIRONMENT WINS
// (verified on Node 22) — so anything added to `env` below silently OVERRIDES .env
// rather than defaulting it. Only put a value here when overriding is what you mean.
//
// See docs/INSTALL.md for the full environment table.
module.exports = {
  apps: [
    {
      name: 'plumichat',
      script: 'server/index.js',
      // cwd: '/absolute/path/to/plumichat',
      node_args: '--env-file=.env',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      watch: false,

      // Restart policy. A crash loop here means the app is unreachable, so the goal
      // is "come back, but never hammer": min_uptime marks a process that dies
      // inside 30s as a failed start (it counts toward max_restarts instead of
      // resetting the counter), and the backoff grows the gap between retries so a
      // persistent failure — a bad .env, a half-installed SDK — leaves the machine
      // idle and diagnosable rather than spinning.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 2000,

      // Leak guard, not a turn guard. PM2 measures THIS process only; the ~340 MB
      // agent CLI that each chat turn spawns is a separate pid and is not counted.
      // The Express server itself idles far below this, so crossing it means
      // "something is leaking", not "someone is using the app". Do not lower it to
      // something a busy server could reach: crossing it restarts the app and drops
      // every in-flight turn without warning.
      max_memory_restart: '900M',

      // Same switch as `pm2 start --time`. Without it the logs have no timestamps,
      // which makes "when did this start failing?" unanswerable.
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Grace period between SIGINT and SIGKILL on a restart. Chat turns are long
      // SSE responses, so give them room to flush an ending instead of vanishing
      // mid-token.
      kill_timeout: 10000,

      env: {
        // Which PM2 process the in-app Restart button targets. Set it explicitly so
        // renaming the app above is a one-line change here rather than a 500 later.
        PM2_APP_NAME: 'plumichat',
        // Everything else is deliberately absent — see the header. PORT and HOST in
        // particular must stay in .env: setting them here would OVERRIDE .env.
      },
    },
  ],
};
