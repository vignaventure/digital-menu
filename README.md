# digital-menu

Digital menu card platform. A super admin onboards restaurants (paid), each restaurant gets a dashboard login to manage categories and items (image, name, description, price), and customers scan a QR code to see a mobile-friendly card-grid menu.

| Who | Where |
|---|---|
| Super admin (you) | `/login` → `/admin` |
| Restaurant owner | `/login` → `/dashboard` (menu, QR code, password) |
| Customer (QR scan) | `/m/<slug>` |
| API clients / mobile apps | `/api/v1`: interactive docs at `/api/docs`, OpenAPI at `/api/v1/openapi.json`, quick reference in [docs/API.md](docs/API.md) |
| Monitoring | `/health` |

## Run locally
Needs a MongoDB database (a free MongoDB Atlas cluster is fine). Put its connection string in `MONGODB_URI` (see `.env.example`), and in Atlas allow your IP under Security > Network Access.
```bash
npm install
MONGODB_URI="mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/" npm start          # http://localhost:3000, admin credentials printed on first run
npm test          # starts its own throwaway MongoDB, never touches Atlas
```
In development the QR codes use your Wi-Fi address (so a phone on the same network can scan them). In production set `BASE_URL`.


## Deploy

The app is one Node process plus a MongoDB database (Atlas) plus uploaded photos stored under `DATA_DIR`. **`DATA_DIR` must be on a persistent volume**, otherwise photos are lost on every deploy. Requires Node ≥ 22.13 (Docker image uses 24).

**Required env in production** (the app refuses to start without them): `MONGODB_URI` (and in Atlas, Network Access must allow the server's IP), `SESSION_SECRET` (≥32 chars, `openssl rand -hex 32`), `BASE_URL` (public https URL, **baked into QR codes — set it before printing any**), and on first run `ADMIN_EMAIL` + `ADMIN_PASSWORD` (≥8 chars). See [.env.example](.env.example).

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

### Moving from the old SQLite version
If you ran an earlier version that kept data in `DATA_DIR/app.db`, copy it into MongoDB once (ids, logins and photos are kept; run it again safely; everyone logs in again):
```bash
node --env-file=/etc/digital-menu/env scripts/migrate-sqlite-to-mongo.js /var/lib/digital-menu/app.db   # or: MONGODB_URI="..." node scripts/…
```

### Backups
- **Database:** MongoDB Atlas. Paid clusters (M10+) have automatic backups; the free M0 tier does not, so take a `mongodump` now and then (`mongodump --uri "$MONGODB_URI" --db digitalmenu`).
- **Photos:** back up `DATA_DIR/uploads/` (a plain folder copy).

## Notes
- **Viewing owner passwords:** login uses a bcrypt hash. Separately, the password the super admin *set* for an owner is kept encrypted (AES-256-GCM, key derived from `SESSION_SECRET`) so the admin can view it with the eye button. It is cleared when the owner changes their own password. **Do not change `SESSION_SECRET` casually**: stored copies become unreadable (show "Not available") until reset; logins keep working. Anyone with the database *and* `SESSION_SECRET` can decrypt them, so protect both.
- Photos are saved on the server's disk, so run a single instance (or move photos to object storage like S3 before adding more).
- Disabling a restaurant or letting `plan_expires` pass hides its menu; disabling also locks the owner out immediately.
