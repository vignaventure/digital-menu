# digital-menu

Digital menu card platform. A super admin onboards restaurants (paid), each restaurant gets a dashboard login to manage categories and items (image, name, description, price), and customers scan a QR code to see a mobile-friendly card-grid menu.

| Who | Where |
|---|---|
| Super admin (you) | `/login` → `/admin` |
| Restaurant owner | `/login` → `/dashboard` (menu, QR code, password) |
| Customer (QR scan) | `/m/<slug>` |
| API clients / mobile apps | `/api/v1` — see [docs/API.md](docs/API.md) |
| Monitoring | `/health` |

## Run locally
```bash
npm install
npm start          # http://localhost:3000, admin credentials printed on first run
npm test
```

## Deploy

The app is one Node process + SQLite file + uploaded images, all stored under `DATA_DIR`. **That directory must be on a persistent volume**, otherwise data is lost on every deploy. Requires Node ≥ 22.13 (Docker image uses 24).

**Required env in production** (the app refuses to start without them): `SESSION_SECRET` (≥32 chars, `openssl rand -hex 32`), `BASE_URL` (public https URL, **baked into QR codes — set it before printing any**), and on first run `ADMIN_EMAIL` + `ADMIN_PASSWORD` (≥8 chars). See [.env.example](.env.example).

### Any server, any project
[docs/SERVER-STANDARD-SETUP.md](docs/SERVER-STANDARD-SETUP.md) is the reusable runbook (one-time server setup, per-project checklist, and a project-config template with this project filled in).

### Ubuntu server (no Docker)
See [docs/DEPLOY-UBUNTU.md](docs/DEPLOY-UBUNTU.md): Node + systemd + Caddy HTTPS, backups, updates.

### Docker (any VPS)
```bash
cp .env.example .env   # fill it in
docker compose up -d --build
```
Put a TLS-terminating proxy in front (Caddy: `menu.vignadigital.com { reverse_proxy localhost:3000 }`).

### Render / Railway / Fly.io
Deploy from this repo using the `Dockerfile`; attach a persistent disk/volume mounted at `/data`, set the env vars above and use `/health` as the health check. `render.yaml` is a ready Render blueprint.

### Backups
Back up `DATA_DIR` (`app.db` plus `uploads/`). With the app stopped, or using `sqlite3 app.db ".backup out.db"`, copy it somewhere safe on a schedule.

## Notes
- **Viewing owner passwords:** login uses a bcrypt hash. Separately, the password the super admin *set* for an owner is kept encrypted (AES-256-GCM, key derived from `SESSION_SECRET`) so the admin can view it with the eye button. It is cleared when the owner changes their own password. **Do not change `SESSION_SECRET` casually**: stored copies become unreadable (show "Not available") until reset; logins keep working. Anyone with the database *and* `SESSION_SECRET` can decrypt them, so protect both.
- Single instance only (SQLite). Scale vertically; move to Postgres + object storage if you need multiple instances.
- Disabling a restaurant or letting `plan_expires` pass hides its menu; disabling also locks the owner out immediately.
