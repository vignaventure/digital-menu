# Deploy on an Ubuntu server (22.04 / 24.04)

Target: `https://menu.vignadigital.com`. Stack: Node 24 + systemd (app) + Caddy (HTTPS, automatic certificates). Run as a sudo user, not root.

## 0. DNS (do first, it takes time to propagate)
Add an **A record**: `menu` → your server's public IP (at your domain registrar). Check: `dig +short menu.vignadigital.com`.

## 1. Server basics
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git ufw curl
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable
```
Port 3000 stays closed; only Caddy is public.

## 2. Install Node 24
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt -y install nodejs
node -v   # must be >= 22.13
```

## 3. Get the code
```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin menucard
sudo mkdir -p /opt/digital-menu /var/lib/digital-menu
sudo git clone https://github.com/vignaventure/digital-menu.git /opt/digital-menu
cd /opt/digital-menu && sudo npm ci --omit=dev
sudo chown -R menucard:menucard /opt/digital-menu /var/lib/digital-menu
```
(Private repo: use a deploy key or a GitHub token for the clone.)

## 4. Configure
```bash
sudo mkdir -p /etc/digital-menu
sudo tee /etc/digital-menu/env >/dev/null <<EOF
NODE_ENV=production
PORT=3000
BASE_URL=https://menu.vignadigital.com
DATA_DIR=/var/lib/digital-menu
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/
MONGODB_DB=digitalmenu
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_EMAIL=admin@vignadigital.com
ADMIN_PASSWORD=CHANGE-ME-LONG-PASSWORD
EOF
sudo chmod 600 /etc/digital-menu/env
```
Edit `ADMIN_PASSWORD` and `MONGODB_URI` (`sudo nano /etc/digital-menu/env`). The admin is created on first start only. `BASE_URL` goes into every QR code, so get it right before printing any.

## 5. Run as a service
```bash
sudo tee /etc/systemd/system/digital-menu.service >/dev/null <<'EOF'
[Unit]
Description=Digital Menu Card
After=network.target

[Service]
User=menucard
WorkingDirectory=/opt/digital-menu
EnvironmentFile=/etc/digital-menu/env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/digital-menu

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now digital-menu
curl -s localhost:3000/health          # {"status":"ok"}
journalctl -u digital-menu -n 30       # logs
```

## 6. HTTPS with Caddy
```bash
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy

sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
menu.vignadigital.com {
    encode gzip
    request_body {
        max_size 8MB
    }
    reverse_proxy localhost:3000
}
EOF
sudo systemctl reload caddy
```
Caddy fetches and renews the certificate itself (needs the DNS record from step 0 and ports 80/443 open).

Verify: open `https://menu.vignadigital.com/login` and sign in with the admin credentials.

## 7. Updating
```bash
cd /opt/digital-menu
sudo -u menucard git pull
sudo -u menucard npm ci --omit=dev
sudo systemctl restart digital-menu
```

## 8. Backups
- **Database (MongoDB Atlas):** paid clusters (M10 and up) back up automatically. The free M0 tier does not, so run `mongodump --uri "$MONGODB_URI" --db digitalmenu --out /var/backups/digital-menu/db-$(date +%F)` now and then (install `mongodb-database-tools`).
- **Photos (on this server):**
```bash
sudo tee /usr/local/bin/menucard-backup >/dev/null <<'EOF'
#!/bin/sh
set -e
D=/var/backups/digital-menu; mkdir -p $D
tar -czf $D/uploads-$(date +%F).tgz -C /var/lib/digital-menu uploads
find $D -type f -mtime +14 -delete
EOF
sudo chmod +x /usr/local/bin/menucard-backup
echo '0 3 * * * root /usr/local/bin/menucard-backup' | sudo tee /etc/cron.d/menucard-backup
```
Copy `/var/backups/digital-menu` off the server occasionally (rsync/S3): a backup on the same disk won't survive losing the server.

## MongoDB Atlas checklist
1. **Network Access:** add this server's public IP (`curl -4 ifconfig.me`) under Security > Network Access. Without it the app stops at start with "Could not connect to MongoDB" (the log shows a TLS alert).
2. **Database user** with read/write access to the `digitalmenu` database (or any database, if you set `MONGODB_DB`).
3. First start creates the collections, indexes and the super admin.
4. **Coming from the old SQLite version?** Copy the data once (ids, logins, photos kept; safe to run twice):
```bash
cd /opt/digital-menu && node --env-file=/etc/digital-menu/env scripts/migrate-sqlite-to-mongo.js /var/lib/digital-menu/app.db
```

## Troubleshooting
| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u digital-menu -n 50`: a missing env var (the app names it), or "Could not connect to MongoDB" (Atlas Network Access, or a wrong `MONGODB_URI`) |
| Caddy certificate error | DNS not pointing to the server yet, or ports 80/443 blocked (also check the provider's firewall panel) |
| 502 from Caddy | `systemctl status digital-menu`; `curl localhost:3000/health` |
| Login rate-limited / wrong IPs in logs | Keep `TRUST_PROXY` unset (default 1 hop, correct for Caddy) |
| Image upload fails | `ls -ld /var/lib/digital-menu/uploads` should be owned by `menucard` |
