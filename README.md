# digital-menu

Digital menu card SaaS: super admin onboards restaurants, owners manage menu items from a web dashboard, customers scan a QR code to view a mobile-friendly card grid menu.

## Run
```
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=choose-one BASE_URL=https://your-domain npm start
```
Env: `PORT` (3000), `BASE_URL` (used in QR codes), `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (first run only).

Routes: `/login`, `/admin` (onboarding), `/dashboard` (menu + QR), `/m/:slug` (public menu).
