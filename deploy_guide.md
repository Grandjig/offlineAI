# License Server Deployment Guide

## Where should you host it?

### ❌ Why NOT Vercel
Vercel runs "serverless" functions — there is **no permanent hard drive**. Your
`licenses.json` would be wiped on every deploy/restart, meaning every customer
loses their license. Vercel only works if you rewrite the server to use a cloud
database (Vercel KV, Postgres), which adds cost and complexity. Skip Vercel.

### ✅ Option 1: Render (recommended, easiest)
- Free tier works for testing (data lost on redeploys)
- **$7/mo "Starter" plan** = permanent disk, never lose licenses → use this
  once you have paying customers
- Deploys straight from GitHub in ~2 minutes

### ✅ Option 2: Your own PC + Cloudflare Tunnel (zero cost, full control)
- Run `node server.js` on your PC
- Expose it to the internet free with Cloudflare Tunnel
- Data lives on your machine forever, backup = copy one folder
- Best if you're hands-on and want $0/month

### ✅ Option 3: Railway ($5/mo, simple alternative to Render)

---

## Option 1: Render — step by step

1. **Push the `license_server` folder to a GitHub repo** (private is fine).

2. **Change the admin password FIRST** — edit `config.json`:
   ```json
   { "admin_password": "YourRealSecretPassword", ... }
   ```

3. Go to [render.com](https://render.com) → New → Web Service → connect your repo.

4. Settings:
   - Root Directory: `license_server`
   - Build Command: `npm install`
   - Start Command: `node server.js`

5. Deploy. Your dashboard will be at:
   `https://your-app.onrender.com/admin`

6. **For permanent storage** (do this once you have real customers):
   - Upgrade to Starter ($7/mo)
   - Add a Disk (mount path `/data`)
   - Set env var `DATA_DIR=/data`

7. Put your real URL into `wrapper.ps1`:
   ```powershell
   $SERVER_URL = "https://your-app.onrender.com"
   ```

> Free tier note: Render sleeps inactive free services after 15 min — the
> customer's first check after idle may take ~30 extra seconds. The client
> scripts treat timeouts as "use local clock", so trials keep working.

---

## Option 2: Your PC + Cloudflare Tunnel — step by step

1. Install Node.js from https://nodejs.org

2. In `license_server` folder, run:
   ```
   npm install
   node server.js
   ```

3. Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

4. Create a free Cloudflare account, then run:
   ```
   cloudflared tunnel --url http://localhost:3000
   ```

5. Cloudflare gives you a URL like
   `https://random-name.trycloudflare.com` — put that in `wrapper.ps1`:
   ```powershell
   $SERVER_URL = "https://random-name.trycloudflare.com"
   ```

6. (Optional) Buy a nice domain and map it in the Cloudflare dashboard.

**Data safety:** everything lives in the `license_server` folder
(`licenses.json`, `machines.json`, `activity.json`). Copy that folder to back up.

---

## Day-to-day usage

### Start the server
```
node server.js
```
Dashboard: `http://localhost:3000/admin` (or your public URL + `/admin`)

### Your dashboard lets you
- ➕ **Create trial licenses** for customers (key auto-copies to clipboard)
- 💚 **Mark paid** when they transfer money
- ⏰ **Extend +14d** if a customer needs more time
- 🚫 **Revoke** instantly (customer blocked within 24h via watchdog)
- 🗑️ **Delete** a license entirely
- 📋 **Activity feed** — see live check-ins, blocked attempts, admin actions
- 🕐 **Last seen** — know when each customer's machine last checked in
- ⬇️ **Backup** — downloads everything as one JSON file

### Anti-cheat built in
- **One trial per machine** — hardware-based ID, deleting files won't reset it
- **Machine binding** — a license key only works on the machine that activated it
- **Trial reset attempts are logged** — you'll see them in the activity feed

---

## API reference

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/register` | POST | none | Client registers its trial (1 per machine) |
| `/api/check` | POST | none | Validate a license |
| `/api/create-trial` | POST | admin | Create trial manually |
| `/admin/licenses` | GET | admin | List licenses + last seen |
| `/admin/activity` | GET | admin | Recent activity feed |
| `/admin/update` | POST | admin | Update license (mark paid etc.) |
| `/admin/revoke` | POST | admin | Revoke / restore |
| `/admin/delete` | POST | admin | Delete a license |
| `/admin/backup` | GET | admin | Download full JSON backup |

Admin auth = send header `Authorization: Bearer YOUR_PASSWORD`

---

## Security checklist before going live
- [ ] Change `admin_password` in `config.json`
- [ ] Use HTTPS (Render and Cloudflare Tunnel both give you this free)
- [ ] Keep the GitHub repo private
- [ ] Download a backup (`⬇️ Backup` button) after any important change
