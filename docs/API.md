# REST API (`/api/v1`)

JSON in/out. Authenticate with `Authorization: Bearer <token>` (token from `POST /auth/login`, valid 12h).
Errors: `{"error": "message"}` with a 4xx/5xx status. Login is rate-limited (20 / 15 min / IP).

## Public (no auth)
| Method | Path | Notes |
|---|---|---|
| GET | `/public/menu/:slug` | Menu for customers: `{restaurant, categories:[{id,name,items:[…]}]}`. 404 if disabled/expired. Only available items. |
| GET | `/health` (root, not `/api/v1`) | Liveness probe |

## Auth
| Method | Path | Body |
|---|---|---|
| POST | `/auth/login` | `{email, password}` → `{token, expires_in, user}` |
| GET | `/auth/me` | |
| POST | `/auth/password` | `{current_password, new_password}` → 204 |

## Super admin (role `admin`)
| Method | Path | Body |
|---|---|---|
| GET | `/admin/restaurants` | |
| POST | `/admin/restaurants` | `{name, email, password, price_paid?, plan_expires? (YYYY-MM-DD)}` → 201. Creates the restaurant **and** the owner login. |
| GET | `/admin/restaurants/:id` | |
| PATCH | `/admin/restaurants/:id` | any of `{name, active, price_paid, plan_expires}` |
| POST | `/admin/restaurants/:id/password` | `{password}` → 204 (reset owner password) |
| DELETE | `/admin/restaurants/:id` | → 204, removes all data and images |

## Restaurant owner (role `owner`)
| Method | Path | Body |
|---|---|---|
| GET | `/restaurant` | Includes `menu_url` |
| GET/POST | `/categories` | POST `{name}` |
| PUT/DELETE | `/categories/:id` | PUT `{name}`; DELETE also removes its items |
| GET | `/items?category_id=` | |
| POST | `/items` | JSON or `multipart/form-data`: `name, description, price, category_id, image` (jpeg/png/webp/gif ≤ 5MB) |
| GET/PUT/DELETE | `/items/:id` | PUT same fields as POST; omit `image` to keep the current one |
| PATCH | `/items/:id/availability` | `{available: true|false}` (omit to toggle) |
| GET | `/qr.png` | PNG QR for the menu URL; `?download=1`, `?size=800` |

### Example
```bash
TOKEN=$(curl -s -X POST $URL/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@spice.com","password":"secret12"}' | jq -r .token)

curl -X POST $URL/api/v1/items -H "authorization: Bearer $TOKEN" \
  -F name="Paneer Tikka" -F description="Smoky" -F price=199 -F category_id=1 -F image=@tikka.jpg
```
