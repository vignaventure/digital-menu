# REST API (`/api/v1`)

The dashboards in this app use this same API, so everything they can do is available to your own clients too.

**Interactive docs: `/api/docs`** (read every endpoint, see example bodies, and try calls from the browser). The machine-readable description is at `/api/v1/openapi.json` (OpenAPI 3), which you can import into Postman, Insomnia or a code generator. The tables below are a quick reference.

JSON in/out. Two ways to authenticate:

- **Bearer token** for API clients: `POST /auth/login`, then send `Authorization: Bearer <token>` (valid 12h).
- **Login cookie** for browsers: `POST /auth/session` sets an HTTP-only cookie. Writes made with the cookie must come from the same site (the `Origin` header is checked).

Errors: `{"error": "message"}` with a 4xx/5xx status. Login is rate-limited (20 / 15 min / IP; `LOGIN_RATE_LIMIT` to change).

## Public (no auth)
| Method | Path | Notes |
|---|---|---|
| GET | `/public/menu/:slug` | Menu for customers: `{restaurant:{name,tagline,theme_color,logo,city,address,phone}, categories:[{id,name,items:[…]}]}`. 404 if inactive/expired. Only available items. |
| GET | `/health` (root, not `/api/v1`) | Liveness probe |

## Auth
| Method | Path | Body |
|---|---|---|
| POST | `/auth/login` | `{identifier, password}`, where `identifier` is the user's **email or mobile number** (`email` is accepted as an alias) → `{token, expires_in, user}` |
| POST | `/auth/session` | same body → sets the login cookie, returns `{role, user}` |
| DELETE | `/auth/session` | log out (cookie) → 204 |
| GET | `/auth/me` | `{user}` |
| POST | `/auth/password` | `{current_password, new_password}` → 204. If an owner changes their own password, the copy the admin can view is cleared. |

## Super admin (role `admin`)
| Method | Path | Body / notes |
|---|---|---|
| GET | `/admin/summary` | `{restaurants, active, inactive, revenue, outstanding}`. Revenue counts onboarding prices marked paid. |
| GET | `/admin/restaurants` | List. Each has `owner`, `city`, `owner_mobile`, `owner_email`, `price_paid`, `paid`, `plan_type`, `plan_expires`, `active`, `has_password`, `item_count`, `menu_url`, … |
| POST | `/admin/restaurants` | `{name, mobile, owner?, email?, city?, price_paid?, paid?, password?, plan_type?, plan_expires?}` → 201. Creates the restaurant **and** the owner login. `mobile` is required (7-15 digits, optional `+`; spaces/dashes ignored) and is the owner's login. `email` is optional. A blank `password` is **generated** and returned once as `generated_password`. `plan_type` is `one_time` (never expires, default) or `limited` (needs `plan_expires`, `YYYY-MM-DD`). 409 if the mobile/email is already used. |
| GET | `/admin/restaurants/:id` | |
| PATCH | `/admin/restaurants/:id` | any of `{name, owner, city, active, price_paid, paid, plan_type, plan_expires, mobile, email, password}`. `active:false` deactivates (menu hidden, owner locked out at once). |
| POST | `/admin/restaurants/:id/reset-password` | Generates a new password → `{mobile, email, password}` |
| POST | `/admin/restaurants/:id/password` | `{password}` sets a specific one → 204 |
| POST | `/admin/restaurants/:id/reveal-password` | `{password}`: the password the admin set (stored encrypted), or `null` if the owner changed it since. |
| DELETE | `/admin/restaurants/:id` | → 204, removes all data and photos |
| (same as the owner's menu endpoints) | `/admin/restaurants/:id/categories`, `/categories/:ref`, `/items`, `/items/:ref`, `/items/:ref/availability` | Manage any restaurant's menu on its behalf ("Manage menu" in the admin console). Same methods, bodies and rules as the owner endpoints below; `:id` is the restaurant, `:ref` the category or item. 404 for an unknown restaurant. |

## Restaurant owner (role `owner`)
| Method | Path | Body / notes |
|---|---|---|
| GET | `/restaurant` | The restaurant's profile incl. `menu_url` |
| PATCH | `/restaurant` | `{name, owner, contact_phone, city, address, tagline, theme_color (#rrggbb), logo (data URL), remove_logo}` |
| GET / POST | `/categories` | GET includes each category's `items` count. POST `{name}` |
| PUT / DELETE | `/categories/:id` | PUT `{name}`. DELETE is refused with 409 while the category still has items. |
| GET | `/items?category_id=` | Each item has `price` (rupees), `image` (path), `image_url` (absolute), `available`, `category` |
| POST | `/items` | `{name, price, category_id, description?, available?, image?}`. `image` is a PNG/JPEG/WebP **data URL** (≤ ~1.5 MB); alternatively send `multipart/form-data` with a file field `image`. |
| GET / PUT / DELETE | `/items/:id` | PUT takes the same fields; omit `image` to keep the photo, send `remove_image: true` to clear it. |
| PATCH | `/items/:id/availability` | `{available: true\|false}` (omit to toggle) |
| GET | `/library/categories` | **Add menu**: categories other restaurants publish (only what guests can already see: shown dishes of active, unexpired restaurants; your own restaurant is left out). Each has `category_id`, `name`, `restaurant`, `items` (dish count). |
| GET | `/library/items?q=&category=&restaurant_id=&limit=&offset=` | Search those dishes: `q` matches name or description, `category` is a category name, `limit` up to 100. Returns `{total, items}`. |
| POST | `/library/import` | `{items: [dishIds], categories: [{category_id, with_items}]}` copies them into your menu: categories are matched by name (created when missing), dishes already in the same category are skipped, photos are copied. Max 300 dishes per call. → `{added_items, skipped_items, added_categories}`. The admin can do the same for any restaurant under `/admin/restaurants/:id/library/...`. |
| GET | `/qr.png` | PNG QR for the menu URL; `?size=800` (128-2048), `?download=1` |

### Example
```bash
TOKEN=$(curl -s -X POST $URL/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"identifier":"9876543210","password":"secret12"}' | jq -r .token)

curl -X POST $URL/api/v1/items -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Paneer Tikka","description":"Smoky","price":199,"category_id":1}'
```
