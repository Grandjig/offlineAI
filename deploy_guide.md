# Licence Server — Deployment Guide

The server is already deployed. This guide is for redeploying it, moving it, or
running a copy locally for testing.

---

## The one thing that matters: where the data lives

Licences are stored in `licenses.json`, `machines.json` and `activity.json`, in
the folder named by `DATA_DIR` (default: the app folder).

| Host | Is the data safe? |
|---|---|
| Render **free** | **No.** The disk is wiped on every restart or deploy, and the service sleeps when idle. You *will* lose licences. |
| Render **Starter (~$7/mo) + Disk** | Yes. This is what you want once you are charging people. |
| Railway / Fly with a volume | Yes. |
| Your own PC + Cloudflare Tunnel | Yes, and free. Data is a folder you can copy. |

The dashboard shows a red banner whenever your data is not on a permanent disk,
so this is hard to forget. Whatever you choose, click **Download backup** after
any day you add customers.

---

## Option 1 — Render (already set up)

1. Push the `license_server` folder to a private GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Settings:
   - Root Directory: `license_server`
   - Build Command: `npm install`
   - Start Command: `node server.js`
4. Environment variables (Render → Environment):

   | Key | Value |
   |---|---|
   | `ADMIN_PASSWORD` | **your real password — set this** |
   | `TRIAL_DAYS` | `14` |
   | `DEVICE_LOCK` | `true` |
   | `OFFLINE_GRACE_DAYS` | `3` |
   | `CHECK_INTERVAL_MINUTES` | `30` |
   | `INSTALLMENT_PERIOD_DAYS` | `30` |
   | `SEARXNG_URL` | web search backend — see `searxng/README.md`. Leave unset and customers simply never see the 🌐 Web button. |
   | `WEBSEARCH_ENABLED` | `true` (ignored while `SEARXNG_URL` is unset) |
   | `WEBSEARCH_TRIAL_ENABLED` | `false` |
   | `WEBSEARCH_QUOTA_MONTHLY` | `300` |

5. **For permanent storage** (do this before you have paying customers):
   - Upgrade the instance to Starter
   - Add a Disk, mount path `/data`
   - Add env var `DATA_DIR` = `/data`

`render.yaml` in this folder describes all of the above, so you can also deploy
it as a Render Blueprint.

---

## Option 2 — Your own PC + Cloudflare Tunnel (free, permanent)

```
npm install
node server.js
cloudflared tunnel --url http://localhost:3000
```

Put the `https://….trycloudflare.com` URL into `client/wrapper.ps1`
(`$SERVER_URL`) and rebuild the zip. Back up by copying the `license_server`
folder.

> Note: a `trycloudflare.com` URL changes every time you restart the tunnel.
> For anything permanent, buy a domain and map it in Cloudflare, or use Render
> with a disk.

---

## Changing the server a customer's copy talks to

Two places, both in `client/`:

- `wrapper.ps1` → `$SERVER_URL = '...'`
- `watchdog.ps1` → the `$ServerUrl` default

For testing, you can avoid editing them at all by setting the
`OFFLINEAI_SERVER` environment variable before launching:

```powershell
$env:OFFLINEAI_SERVER = 'http://localhost:3000'
.\wrapper.ps1
```

---

## Running it locally

```bash
npm install

# a throwaway instance on port 3999, so you never touch live data
ADMIN_PASSWORD=testpass123 DATA_DIR=./test-data PORT=3999 node server.js

# in another window — exercises 22 behaviours end to end
ADMIN_PASSWORD=testpass123 BASE=http://localhost:3999 node smoke-test.js
```

For the web search half, point the server at a running SearXNG and use the other
suite:

```bash
SEARXNG_URL=http://127.0.0.1:8080 ADMIN_PASSWORD=testpass123 DATA_DIR=./test-data PORT=3999 node server.js

# in another window — 25 behaviours covering search, quotas and the relevance guard
BASE=http://localhost:3999 node websearch-test.js
```

Delete `test-data/` when you are done.

---

## API reference

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | none | Is it alive, and what settings is it using |
| `/api/register` | POST | none | Customer's first run — grants the one-per-machine trial |
| `/api/activate` | POST | none | Activate with a product key you sold |
| `/api/check` | POST | none | Routine validity check (launcher + watchdog) |
| `/api/websearch` | POST | licence key | **Web search** for the chat window. Needs a valid, active licence, an allowed customer, and remaining quota. Returns normalised results, or `ok:false` when nothing relevant came back. CORS-open because the chat page is a local file. |
| `/admin/licenses` | GET | admin | Every licence with computed status and last seen |
| `/admin/activity` | GET | admin | Recent events |
| `/admin/config` | GET | admin | Active settings |
| `/admin/create` | POST | admin | Issue a product key |
| `/admin/enable` | POST | admin | **Kill switch** — on/off |
| `/admin/set-expiry` | POST | admin | Set an exact end date, or make it permanent |
| `/admin/add-days` | POST | admin | Extend (or shorten) by N days |
| `/admin/payment` | POST | admin | Record an instalment and extend access |
| `/admin/own` | POST | admin | Mark fully paid — permanent |
| `/admin/reset-device` | POST | admin | Unlock the key for a new computer |
| `/admin/update` | POST | admin | Edit customer details / notes / plan |
| `/admin/websearch` | POST | admin | Per-customer web search: `enabled` (`true` / `false` / `"default"`), `quota`, `resetUsage` |
| `/admin/delete` | POST | admin | Remove a licence |
| `/admin/backup` | GET | admin | Download everything as JSON |
| `/admin/restore` | POST | admin | Upload that JSON to recover after a wipe |

Admin auth is the header `Authorization: Bearer <ADMIN_PASSWORD>`.

---

## Security checklist

- [ ] `ADMIN_PASSWORD` set as an environment variable on the host
- [ ] `DATA_DIR` on a permanent disk
- [ ] Repo private
- [ ] Backup downloaded after any busy day
- [ ] SearXNG reachable only from this server (same host, or behind the token proxy in `searxng/Caddyfile`) — its JSON API is on and its rate limiter is off by design
