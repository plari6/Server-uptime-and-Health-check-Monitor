# Server Uptime & Health Check Monitor

Checks a company's websites, APIs, databases and mail servers every 60 seconds. When something breaks, it tells the IT team on **Telegram** within about a minute, and it tells them again when the service comes back and how long it was down. Unanswered alerts are sent on to managers. It also serves a public status page, Prometheus metrics and monthly SLA reports.

**Stack:** JavaScript (Node.js 22.13+ ESM). The project card names Node-Cron, Axios and the Telegram Bot API, and a cron daemon with a bot is the simplest fit for plain Node. It has two dependencies (`node-cron`, `axios`) and uses SQLite built into Node (`node:sqlite`), so there's nothing to compile.

```
node-cron tick (5 s) ──► due monitors (own interval, default 60 s, parallel, limited)
   │                       HTTP(S): status / keyword / "error text" / JSON field / latency / SSL expiry
   │                       TCP: database, SMTP, Redis, any port
   ▼
network guard ── all checks fail? ask canaries (google 204, 1.1.1.1) ── offline ► pause, no false alarms
   ▼
state machine (retries, failThreshold, recoverThreshold, degraded after N slow checks)
   ▼
SQLite: checks, incidents, state (survives restarts, no duplicate alerts)
   ▼
alerts ► Telegram (HTML, Acknowledge / Mute buttons, digest when many) · Slack · signed JSON webhook (n8n/Make)
        reminders every 30 min until acknowledged · escalation chat after 15 min · daily summary
```

## Quick start

```bash
npm install
node bin/uptime-monitor.js demo          # offline demo: outage story, Telegram messages, reports in data/
node bin/uptime-monitor.js init          # creates monitors.json and .env
#   edit monitors.json (endpoints) and .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
node bin/uptime-monitor.js doctor        # checks token, chat access, database, internet
node bin/uptime-monitor.js notify-test   # "Test alert" in the IT group
node bin/uptime-monitor.js check         # one round, table, exit code 1 if anything is down
node bin/uptime-monitor.js start --port 8080
```

Telegram setup: create a bot with [@BotFather](https://t.me/BotFather), add it to the IT group, send a message in the group, and open `https://api.telegram.org/bot<TOKEN>/getUpdates` to find the group id (`-100…`). `doctor` confirms the bot can post there.

## Commands

| Command | What it does |
|---|---|
| `init [--force]` | Copy `monitors.example.json` → `monitors.json` and `.env.example` → `.env` |
| `validate` | Validate config and settings, list monitors and alert channels |
| `check [--only name] [--json]` | Run all checks once with no state and no alerts. Exit code `1` if any is down, so it fits CI, deploy pipelines and cron |
| `start [--port 8080] [--no-bot]` | The daemon: scheduler, alerts, Telegram commands, status page |
| `status [--json]` | Last known state of every monitor, with 24 h uptime |
| `incidents [--open] [--limit 20]` | Incident history (start, duration, cause, who acknowledged) |
| `report [--days 30] [--format html,csv,json] [--out reports]` | SLA report: uptime %, SLA met or breached, error budget, MTTR, p95 latency |
| `notify-test` | Send a test message to every channel |
| `doctor` | Health of the setup itself |
| `demo [--telegram]` | Offline demo with fake services and a simulated clock. `--telegram` also sends the demo alerts to your real chat |

Global options: `--config monitors.json`, `--db data/uptime.db`.

## monitors.json

```json
{
  "defaults": { "interval": 60, "timeoutMs": 10000, "retries": 1, "maxLatencyMs": 3000, "sslWarnDays": 14,
                "remindEveryMin": 30, "escalateAfterMin": 15 },
  "monitors": [
    { "name": "Website", "url": "https://acme.com/", "keyword": "Add to cart", "sla": 99.9 },
    { "name": "API", "url": "https://api.acme.com/health", "json": { "path": "db", "equals": "up" },
      "headers": { "Authorization": "Bearer ${API_TOKEN}" }, "owner": "@backend_oncall" },
    { "name": "Postgres", "type": "tcp", "host": "10.0.0.5", "port": 5432, "public": false }
  ],
  "maintenance": [
    { "monitors": ["API"], "start": "2026-12-01T01:00:00Z", "end": "2026-12-01T03:00:00Z", "reason": "DB upgrade" },
    { "tags": ["internal"], "weekly": { "days": ["sun"], "from": "02:00", "to": "03:00" } }
  ]
}
```

| Field | Default | Meaning |
|---|---|---|
| `type` | `http` (or `tcp` when `port` is given) | `http` or `tcp` |
| `url`, `method`, `headers`, `body`, `basicAuth` | GET | Request. `${ENV_VAR}` placeholders keep secrets in `.env`, and they're masked in alerts |
| `expectStatus` | `200-399` | `"2xx"`, `"200-299,301"`, `[200, 401]` |
| `keyword` / `notKeyword` | | Text that must (or must not) appear on the page, e.g. `"Fatal error"` |
| `json` | | `{path, equals}`, `{path, in: [...]}`, `{path, exists}`, `{path, max/min}`; one rule or a list |
| `interval` | 60 | Seconds between checks (min 5) |
| `timeoutMs`, `retries`, `retryDelayMs` | 10000, 1, 3000 | An immediate re-try filters single packet losses |
| `failThreshold` / `recoverThreshold` | 1 / 1 | Failed checks in a row before DOWN; good checks in a row before RECOVERED |
| `maxLatencyMs`, `degradedAfter` | 0 (off), 3 | SLOW alert after N slow checks in a row; "back to normal" after 2 fast ones |
| `sslWarnDays` | 14 | Certificate warnings at 14 / 7 / 3 / 1 / 0 days (checked every 6 h) |
| `remindEveryMin` | 30 | "Still down" reminders until someone acknowledges |
| `escalateAfterMin` | 15 | Sent to `TELEGRAM_ESCALATION_CHAT_ID` too if nobody acknowledged |
| `sla` | | Target uptime % for reports and the daily summary |
| `owner` | | `@username` mentioned in alerts |
| `telegramChatId` | | Send this monitor's alerts to another group, e.g. a client's own group |
| `tags`, `public` | `[]`, true | Maintenance by tag; `public: false` hides the monitor from the status page |

`monitors.json` is re-read automatically when it changes, so there's no restart. An invalid edit is ignored and logged, and the previous config keeps running.

## Telegram bot commands

`/status` · `/down` · `/incidents` · `/uptime [hours]` · `/check <name>` · `/ack <incident# | name>` · `/mute <name|all> [minutes]` · `/unmute <name|all>`

Alerts have **✅ Acknowledge** and **🔕 Mute 1h** buttons. The bot only answers chats and users listed in `TELEGRAM_CHAT_ID`, `TELEGRAM_ESCALATION_CHAT_ID` and `TELEGRAM_ADMIN_IDS`, and stays silent for everyone else. It uses long polling, so it needs no public URL. Set `TELEGRAM_COMMANDS=false` if another app already polls the same bot.

## Alert behaviour

- **Status vs. notified.** Alerts fire when the real status differs from what the team was last told. So:
  - A service that goes down and comes back inside a maintenance window or mute never pages anyone.
  - One that is still down when the window ends pages right then.
  - Recoveries are always sent when the team knows about the outage.
- **No alert storms.** More than 3 updates for one chat in the same round become one digest message. Telegram 429 responses are retried after `retry_after`.
- **No false alarms from the monitor's own network.** If every check fails at once, or DNS fails, the canaries are asked first. If they're unreachable too, verdicts pause, the uptime numbers aren't affected, and a "connectivity restored" note follows.
- **Restarts are safe.** State lives in SQLite, so a restart doesn't re-send DOWN for an incident that's already known. Start and stop messages tell the team when monitoring is paused.
- **Dead-man switch.** Set `HEARTBEAT_URL` (e.g. healthchecks.io) to get warned if the monitor host itself dies.

## HTTP endpoints (`start --port 8080`)

| Path | |
|---|---|
| `/` | Public status page: overall banner, 30-day uptime bars, 14-day incidents, dark mode, auto refresh |
| `/api/status` | JSON. Public monitors only, without targets, unless you send `Authorization: Bearer $STATUS_API_TOKEN` |
| `/api/incidents` | JSON incident history (token) |
| `/metrics` | Prometheus/Grafana: up, latency, degraded, 24 h uptime ratio, network_down (token) |
| `/health` | 200 while the scheduler is ticking, 503 if it stalls (Docker HEALTHCHECK) |

## Webhook payload (n8n / Make / Zapier / PagerDuty bridge)

`ALERT_WEBHOOK_URL` receives one JSON POST per event:

```json
{ "type": "DOWN", "at": "2026-11-18T10:32:17.000Z", "monitor": { "id": "api", "name": "API", "target": "https://api.acme.com/health", "tags": [], "owner": "@backend_oncall" },
  "incident_id": 12, "cause": "HTTP 502 Bad Gateway", "http_status": 502, "latency_ms": 41, "downtime_ms": null, "since": "2026-11-18T10:32:17.000Z" }
```

Event types: `DOWN`, `RECOVERED`, `DEGRADED`, `PERF_RECOVERED`, `STILL_DOWN`, `ESCALATE`, `SSL_EXPIRING`, `NETWORK_RESTORED`. When `ALERT_WEBHOOK_SECRET` is set, the request carries `X-Uptime-Timestamp` and `X-Uptime-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`.

## Deploy

```bash
docker compose up -d --build      # uses .env + ./monitors.json, data in a volume, /health checked
```

Without Docker, run `node bin/uptime-monitor.js start --port 8080` under pm2, systemd or a Windows service. Run the monitor **outside** the network it watches, for example on a $5 VPS, so a power cut in the office doesn't take the monitor down with it.

## Library use

```js
import { loadConfig, loadSettings, openStore, createNotifier, UptimeMonitor } from 'server-uptime-health-monitor';
const settings = loadSettings();
const store = openStore('data/uptime.db');
const monitor = new UptimeMonitor({ config: loadConfig('monitors.json'), settings, store, notifier: createNotifier(settings, { store }) });
await monitor.start();
```

## Tests

`npm test` runs 45 tests with no network and no keys. They use fake services, a fake Telegram API and a simulated clock, and cover the HTTP/TCP/TLS checks, thresholds, reminders, escalation, maintenance, the network guard, restart persistence, bot commands and buttons, the webhook signature, the status server, the reports, and the CLI including a full daemon run.
