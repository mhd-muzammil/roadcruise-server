# Road Cruise API — VPS Deployment (test/preview phase)

> **Deploying with Dokploy?** Jump to the [Dokploy section](#deploying-with-dokploy)
> — you do NOT need the manual Node/PM2/Nginx steps below (Dokploy handles those).
> The one thing you MUST do is add a **persistent volume** for the data, or every
> redeploy wipes all bookings/users/payments. Details in that section.

---


Deploy the backend as-is with the current **test keys** (Razorpay test, Brevo SMTP).
When the client is happy, you only swap `.env` values — no code changes.

Good news: the database is Node's built-in `node:sqlite`, so there is **no native
module to compile** — deployment is just "copy folder, install, run".

---

## 0. Prerequisites on the VPS (Ubuntu/Debian assumed)

Use **Node 24** (same as local — `node:sqlite` needs Node ≥ 22.5 and runs flag-free on 24).

```bash
# Install Node 24 via nodesource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v            # should print v24.x

# Process manager (keeps the API running + restarts on reboot/crash)
sudo npm install -g pm2
```

---

## 1. Copy the `server/` folder to the VPS

The repo isn't a git repo, so copy the folder directly. **Exclude `node_modules`**
(reinstall on the server) — and, for a clean preview instance, exclude the local
DB/data so it starts fresh.

From your local machine (Git Bash / WSL):

```bash
rsync -av --progress \
  --exclude node_modules \
  --exclude 'src/config/roadcruise.db*' \
  --exclude 'src/*/data' \
  ./server/  user@YOUR_VPS_IP:/opt/roadcruise/server/
```

(No rsync? Zip `server/` without `node_modules`, `scp` it up, and unzip.)

> Note: `.env` is copied by the command above (it's a normal file in `server/`).
> If you'd rather not send secrets over rsync, create `.env` on the server by hand
> in step 3.

---

## 2. Install dependencies

```bash
cd /opt/roadcruise/server
npm install --omit=dev        # installs express/cors/dotenv + razorpay + nodemailer, etc.
```

---

## 3. Create / verify `.env` on the VPS

If you didn't copy it, create `/opt/roadcruise/server/.env` with the SAME values you
use locally. The ones that matter for the preview:

```
PORT=5000

# Payments — Razorpay TEST keys (client preview)
PAYMENTS_ENABLED=true
PAYMENT_PROVIDER=razorpay
PAYMENT_WEBHOOK_ENABLED=false
RAZORPAY_KEY_ID=rzp_test_TA8eppoRquhfcf
RAZORPAY_KEY_SECRET=T3pKqZcQ9CwsLtzfSqC6r37B

# Email — Brevo SMTP (real emails)
NOTIF_EMAIL_PROVIDER=smtp
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=...            # your Brevo login
SMTP_PASS=...            # your Brevo SMTP key
SMTP_FROM=Road Cruise <zamil627810@gmail.com>
SUPPORT_EMAIL=zamil627810@gmail.com
ADMIN_EMAIL=zamil627810@gmail.com
ADMIN_WHATSAPP=+916380422961

# Admin API token (required in production mode)
NOTIF_ADMIN_TOKEN=...    # keep your existing value
```

⚠️ **SMTP port**: many VPS providers **block outbound port 587/465 by default** to
stop spam. If admin/customer emails don't arrive, open a support ticket to unblock
SMTP, or use Brevo's HTTP API instead. Test after deploy (step 6).

---

## 4. Start with PM2

```bash
cd /opt/roadcruise/server
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # run the command it prints, to auto-start on reboot
pm2 logs roadcruise-api   # watch startup — should print "Server running on port 5000"
```

The SQLite DB (`src/config/roadcruise.db`) and the `src/*/data/*.json` stores are
created automatically on first run and persist on disk.

---

## 5. Expose it (pick one)

**A. Quick — open the port directly (HTTP, fine for a quick demo):**
```bash
sudo ufw allow 5000/tcp
# API reachable at http://YOUR_VPS_IP:5000/api
```

**B. Recommended — Nginx reverse proxy + free HTTPS (needs a domain/subdomain):**
Point e.g. `api.roadcruise.in` A-record to the VPS IP, then:
```bash
sudo apt-get install -y nginx
sudo tee /etc/nginx/sites-available/roadcruise <<'NGINX'
server {
    server_name api.roadcruise.in;
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX
sudo ln -s /etc/nginx/sites-available/roadcruise /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Free HTTPS
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.roadcruise.in
```
API is then at `https://api.roadcruise.in/api`. **Use B if the frontend is served
over HTTPS** — a secure site can't call an `http://` API (mixed content), and the
Razorpay checkout is happiest over HTTPS.

---

## 6. Smoke-test the deploy

```bash
# Health / reachable?
curl http://YOUR_VPS_IP:5000/api/payments/config
# -> {"enabled":true,"provider":"razorpay",...}
```
Then from the live site: register/login, make a test booking, pay with Razorpay test
card `4111 1111 1111 1111` (any future expiry/CVV), and confirm the customer + admin
emails arrive. If emails fail, revisit the SMTP-port note in step 3.

---

## 7. Point the frontend at the VPS

The client reads `VITE_API_URL`. Set it to your deployed API and rebuild:

```
# client/.env (or your host's env settings)
VITE_API_URL=https://api.roadcruise.in/api      # or http://YOUR_VPS_IP:5000/api
```
```bash
cd client && npm run build   # redeploy the dist/ output
```

CORS is currently open (`app.use(cors())`), so any frontend origin works during the
preview. Lock it to your domain before real launch.

---

## Going live later (after client sign-off)

Only `.env` changes — no redeploy of code logic:
1. `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` → **live** `rzp_live_*` keys.
2. Register a webhook in the Razorpay dashboard → `https://api.roadcruise.in/api/payments/webhook`,
   put its secret in `RAZORPAY_WEBHOOK_SECRET`, and set `PAYMENT_WEBHOOK_ENABLED=true`.
3. Point `ADMIN_EMAIL` / `SUPPORT_EMAIL` to the real business inbox; use a verified
   Brevo sender domain for `SMTP_FROM`.
4. `pm2 restart roadcruise-api`.

## Updating the deployed code
```bash
# re-copy changed files (rsync as in step 1, keep the excludes), then:
cd /opt/roadcruise/server && npm install --omit=dev && pm2 restart roadcruise-api
```

## Backups
Back up these (they hold all data): `src/config/roadcruise.db` and every
`src/*/data/*.json` — or, if you set `DATA_DIR`, just back up that one folder.
A nightly `cp`/`tar` cron is enough for the preview phase.

---

# Deploying with Dokploy

Dokploy builds your app into a **Docker container and runs it. The container
filesystem is EPHEMERAL** — it is thrown away and rebuilt on every deploy/rebuild.
Your app persists data in files (the `node:sqlite` DB + JSON stores), so **without a
persistent volume, every redeploy erases all bookings, users, payments and
notifications.** This is the single most important thing to get right.

To make that easy, the app now supports one env var — **`DATA_DIR`** — that puts
ALL persistent data (SQLite DB + backups + every JSON store) under a single folder.
Mount ONE volume there and your data survives forever.

## 1. Provider + Build Type (Dockerfile)
On the app's **General → Provider** tab, connect your repo (e.g. `roadcruise-server`),
branch `main`, **Build Path `/`** (the repo root *is* the server folder).

Under **Build Type**, choose **Dockerfile** (a production `Dockerfile` + `.dockerignore`
ship in the repo root):
- **Docker File**: `Dockerfile`
- **Docker Context Path**: `.`

The image is a lean multi-stage Alpine build on Node 24: it compiles the one native
module (argon2) in a throwaway builder stage, runs as a non-root user, listens on
`5000`, and defaults `DATA_DIR=/data`.

## 2. Environment (the .env)
On the **Environment** tab, paste the same variables you use locally (Razorpay TEST
keys, Brevo SMTP, `ADMIN_EMAIL`, `NOTIF_ADMIN_TOKEN`, etc.) — Dokploy injects these as
env vars, so you do NOT commit `.env`. `PORT=5000` and `DATA_DIR=/data` are already
baked into the image, so you don't need to re-add them (override only if you want to).

## 3. Persistent volume  ← the critical step
On the **Advanced → Volumes** (Mounts) tab, add a **Volume Mount**:
- **Type**: Volume Mount (a named Docker volume — survives redeploys)
- **Volume Name**: `roadcruise-data`
- **Mount Path** (in container): `/data`   ← must match `DATA_DIR`

That single mount now holds everything:
```
/data/
  config/         → roadcruise.db (+ WAL) + backups/
  auth/           → sessions.json, auth_audit.json
  payments/       → payments.json
  notifications/  → notifications.json
```
Because it's a named volume, deploys/rebuilds keep the data, and Docker seeds it with
the image's `node`-user ownership on first mount so the non-root app can write to it.
Prefer a **Volume Mount** (named) over a **Bind Mount** — a bind mount comes up
root-owned and the non-root app would hit `EACCES` on `/data`.

## 4. Domain + HTTPS
On the **Domains** tab, add your API host (e.g. `api.roadcruise.in`), choose HTTPS —
Dokploy provisions a Let's Encrypt cert via Traefik automatically. Internal port: `5000`.

## 5. Deploy
Hit **Deploy**. Watch **Logs** for `Server running on port 5000`. Then smoke-test:
```
https://api.roadcruise.in/api/payments/config   → {"provider":"razorpay",...}
```

## 6. Point the frontend at it
Set the client's `VITE_API_URL=https://api.roadcruise.in/api` and rebuild/redeploy the
frontend (you can host the client as a second Dokploy app — a static/Vite build — or on
Netlify/Vercel).

## Dokploy gotchas
- **Redeploy without the volume = data loss.** Confirm the `/data` mount exists
  BEFORE your first real bookings. Verify after deploy: Open Terminal → `ls /data`.
- **The volume mount path must match `DATA_DIR`** (`/data`). If you change one, change both.
- **SMTP port 587 outbound** may be blocked by the VPS host (see the note in step 3 of
  the manual guide). Test emails right after deploy.
- **Backups**: use Dokploy's **Volume Backups** tab on `roadcruise-data`, and/or the
  app's own startup DB snapshots now live in `/app/data/config/backups/`.
- **Going live**: same as above — swap Razorpay test→live keys + email sender in the
  Environment tab, enable the webhook, and redeploy. Data in the volume is untouched.
