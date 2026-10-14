# Standard server setup (any project, Ubuntu 22.04/24.04)

Use this for **every** project on the server. Part A is done once per server. Part B is repeated per project. Part C is the only thing that differs between projects: copy it, fill it in, keep it with that project's repo.

Layout convention (one app = one name, e.g. `digital-menu`):

| Thing | Path / name |
|---|---|
| Code | `/opt/<app>` |
| Persistent data (db, uploads) | `/var/lib/<app>` |
| Env file (secrets, 600) | `/etc/<app>/env` |
| Service user | `<app>` (no login shell) |
| systemd unit | `<app>.service` |
| Local port | unique per app (3000, 3001, 3002…) |
| Public site | one block per domain in `/etc/caddy/Caddyfile` |

---

## Part A: once per server

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git ufw curl debian-keyring debian-archive-keyring apt-transport-https
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable
```
App ports are **never** opened in the firewall; only Caddy (80/443) is public.

Install Caddy (HTTPS reverse proxy, auto certificates):
```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
```
Install the runtime(s) your projects need (only once):

| Stack | Install |
|---|---|
| Node | `curl -fsSL https://deb.nodesource.com/setup_24.x \| sudo -E bash - && sudo apt -y install nodejs` |
| Python | `sudo apt -y install python3 python3-venv python3-pip` |
| Docker | `curl -fsSL https://get.docker.com \| sudo sh` |
| Postgres | `sudo apt -y install postgresql` |
| Static site | nothing (Caddy serves files) |

## Part B: per project (checklist)

1. **DNS first:** `A` record `<subdomain>` → server IP. Check: `dig +short <domain>`.
2. **Pick a free port:** `sudo ss -tlnp | grep LISTEN`.
3. **Create user + folders** (replace `APP`):
   ```bash
   sudo useradd --system --create-home --shell /usr/sbin/nologin APP
   sudo mkdir -p /opt/APP /var/lib/APP /etc/APP
   ```
4. **Get code** into `/opt/APP` (`git clone <repo> /opt/APP`; private repo → deploy key/token).
5. **Install dependencies / build** (Part C: *Build*).
6. **Write `/etc/APP/env`** with the project's variables (Part C), then `sudo chmod 600 /etc/APP/env`. Never commit secrets.
7. **Ownership:** `sudo chown -R APP:APP /opt/APP /var/lib/APP`.
8. **systemd service** `/etc/systemd/system/APP.service`:
   ```ini
   [Unit]
   Description=APP
   After=network.target

   [Service]
   User=APP
   WorkingDirectory=/opt/APP
   EnvironmentFile=/etc/APP/env
   ExecStart=<START COMMAND from Part C>
   Restart=always
   RestartSec=3
   NoNewPrivileges=true
   ProtectSystem=full
   ProtectHome=true
   ReadWritePaths=/var/lib/APP

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now APP
   ```
9. **Caddy:** append to `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`:
   ```
   app.example.com {
       encode gzip
       reverse_proxy localhost:PORT
   }
   ```
10. **Verify:** `curl -s localhost:PORT/<health path>` then open `https://<domain>`; check `sudo journalctl -u APP -n 50`.
11. **Backups:** schedule backup of `/var/lib/APP` (+ DB dump if Postgres/MySQL) and copy off-server.
12. **Record Part C** for the project (below) so the next person can redeploy it.

### Updating a project
```bash
cd /opt/APP && sudo -u APP git pull && <Build commands> && sudo systemctl restart APP
```
### Rollback
```bash
cd /opt/APP && sudo -u APP git checkout <previous-commit> && <Build commands> && sudo systemctl restart APP
```
Restore data from the latest backup if the release changed the database.

---

## Part C: project-specific config (copy per project)

```
Project name:        
Repo:                
Domain:              
Local port:          
Runtime / version:   
Build commands:      
Start command:       
Health check path:   
Env variables:       (name – required? – how to generate)
Persistent data:     (what must survive redeploys, where)
First-run steps:     (admin user, migrations, seed)
Backup method:       
Gotchas:             
```

### Project: digital-menu (filled in)

```
Project name:        digital-menu (digital menu card + QR, SaaS for restaurants)
Repo:                https://github.com/vignaventure/digital-menu
Domain:              menu.vignadigital.com
Local port:          3000
Runtime / version:   Node >= 22.13 (use 24). Database: MongoDB Atlas
Build commands:      npm ci --omit=dev
Start command:       /usr/bin/node server.js
Health check path:   /health   (returns {"status":"ok"})
Env variables:       NODE_ENV=production                 required
                     PORT=3000                           required
                     BASE_URL=https://menu.vignadigital.com   required; baked into QR codes
                     DATA_DIR=/var/lib/digital-menu      required; uploaded photos
                     MONGODB_URI=mongodb+srv://...       required; Atlas connection string
                     MONGODB_DB=digitalmenu              optional; database name
                     SESSION_SECRET                      required; openssl rand -hex 32
                     ADMIN_EMAIL, ADMIN_PASSWORD         required on FIRST start only (pw >= 8 chars)
                     TRUST_PROXY                         optional; leave unset behind Caddy
Persistent data:     MongoDB Atlas (all records) and $DATA_DIR/uploads/ (restaurant photos)
First-run steps:     Atlas > Network Access: allow the server IP. Super admin is auto-created from ADMIN_* on first start.
                     From the old SQLite version: node scripts/migrate-sqlite-to-mongo.js <app.db> (once)
Backup method:       Atlas backups (M10+) or mongodump (free M0) + tar of uploads/ (see DEPLOY-UBUNTU.md)
Gotchas:             - App refuses to start in production without SESSION_SECRET/BASE_URL
                     - Changing BASE_URL later invalidates every printed QR code
                     - Photos are on local disk, so run a single instance
                     - App won't start if Atlas does not allow the server's IP (Network Access)
                     - Caddy request body limit 8MB (uploads are capped at 5MB)
```
Full copy-paste commands for this project: [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md).
