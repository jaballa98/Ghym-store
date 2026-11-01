# Ghym Store

E-commerce web app: guests, customers and admins, per-size stock, discounts, and map-based delivery fees.
**Zero npm dependencies.** Needs Node.js 22.5 or newer (uses the built-in `node:sqlite`).

## Run

    node --no-warnings server.js        # or: npm start
    open http://localhost:3000

Admin panel: http://localhost:3000/#/admin. The first start creates the main admin `admin` / `admingb`.
**Change that before going live.** Set your own on the first start (empty `data/` folder):

    ADMIN_USER=yourname ADMIN_PASS='a-long-password' node --no-warnings server.js

Other environment variables: `PORT`, `JWT_SECRET` (otherwise generated into `data/.secret`), `DATA_DIR`, `SEED_SAMPLE=0` (no sample products).
Tests: `npm test` (28 API checks on an in-memory database).

## Files

    server.js          HTTP server and all routes (no framework), security headers, login throttling
    lib/db.js          SQLite schema, settings, seed data, transaction helper
    lib/auth.js        scrypt password hashing, HMAC-signed tokens
    lib/validate.js    registration rules (Gmail/iCloud, phones, username, coordinates)
    lib/delivery.js    Haversine distance and pricing engine
    public/            frontend (vanilla JS single-page app, Leaflet + OpenStreetMap)
    test/smoke.js      API test suite

## Database (SQLite)

| Table | Purpose |
|---|---|
| `users` | Customers. `username` is `UNIQUE COLLATE NOCASE`, so "Sara" and "sara" collide. Stores city, phones, email, pin lat/lng. |
| `admins` | Main admin (`is_super=1`) and staff. `permissions` is a JSON list. |
| `cities` | Name, fixed `delivery_fee`, `active`. |
| `categories` | Store categories. Deleting one leaves its products uncategorised. |
| `products` | Price, `discount_percent` (0-100), image, `active`. |
| `product_variants` | One row per size with its own `stock`. Products without sizes get one `Standard` row. |
| `cart_items` | `UNIQUE(user_id, variant_id)`. |
| `wishlist` | `PRIMARY KEY(user_id, product_id)`. |
| `orders`, `order_items` | Price, distance and fee are saved at checkout. Cancelling an order returns stock. |
| `settings` | Store lat/lng, base fee, price per km, road factor, pricing mode, currency. |

## Roles

- **Guest:** browses freely. Cart and wishlist endpoints answer `401 {auth_required:true}`; the UI opens the sign-up form and completes the action after sign-up.
- **Customer:** registers with first and last name, city, phone 1 (and optional phone 2), Gmail or iCloud email, map pin, unique username, password and confirmation. A valid sign-up creates the account and logs the user in.
- **Admin:** the main admin has full access and manages staff. Staff get only the privileges ticked for them: `products`, `categories`, `cities`, `orders`, `settings`. A staff account needs a username and password (8+ characters).

## Delivery fee

`distance_km = haversine(store, customer) x road_factor` (default 1.25, because roads are longer than straight lines).
The admin chooses how it combines with city prices in Admin > Settings:

| Mode | Fee |
|---|---|
| `highest` (default) | `max(base + km x per_km, city price)` |
| `distance` | `base + km x per_km` |
| `city` | the city's fixed price |
| `city_base` | `city price + km x per_km` |

The checkout page calls `POST /api/delivery/quote` whenever the pin or city changes and shows distance, fee and total.
`POST /api/checkout` recomputes the fee on the server, so the browser cannot change it.

## API summary

- Public: `GET /api/config`, `GET /api/products`, `GET /api/products/:id`, `GET /api/username-available?u=`, `POST /api/delivery/quote`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/admin/login`
- Customer (Bearer token): `GET /api/me`, `GET|POST|PATCH|DELETE /api/cart`, `GET|POST|DELETE /api/wishlist/:id`, `POST /api/checkout`, `GET /api/orders`
- Admin (Bearer token and privilege): `/api/admin/{cities,categories,products,orders,settings,staff}`

## Before going live

- Serve over HTTPS (Caddy or nginx in front, or a host such as Render, Railway or Fly with a persistent disk for `data/`).
- Set `JWT_SECRET` and a strong admin password.
- The map uses free OpenStreetMap tiles. For heavy traffic use a tile provider with an API key.
- Payment is cash on delivery. Add a payment provider before taking cards.
- Back up `data/ghym.db`.
