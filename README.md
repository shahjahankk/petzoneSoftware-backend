# PetZone POS Backend

Node.js / Express API for PetZone POS: branches, warehouses, inventory, sales, companies, ledgers, and admin settings.

Pairs with [petzone-pos-frontend](../../petzone-pos-frontend).

## Requirements

- Node.js 16+
- npm 8+
- MySQL 5.7+ / 8

## Quick start

```bash
cd backend/petzoneSoftware-backend
npm install
cp .env.example .env
# Edit .env with your MySQL and JWT values
npm start
```

API default: `http://localhost:5000`

Health check: `GET /api/health`

## Environment

Copy `.env.example` to `.env`. Do not commit `.env`.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `5000`) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Main POS database |
| `QUEUE_DB_NAME` | Queue management database |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Auth tokens |
| `CORS_ORIGIN` | Frontend origin |
| `INVENTORY_ALLOW_NEGATIVE_STOCK` | Allow stock below zero on sales |

Remote MySQL (HostNext / cPanel) must whitelist your machine IP before local scripts or the API can connect.

## Scripts

```bash
npm start          # development
npm run prod       # NODE_ENV=production (Unix)
npm run cpanel     # same as prod (cPanel)
```

On Windows, use `npm start` or set `NODE_ENV=production` in `.env`.

Useful one-off scripts live in `scripts/` (for example adding `branches.allow_company_view`).

## Auth

Most `/api/*` routes need `Authorization: Bearer <token>`.

Skipped:

- `/api/auth/*`
- `/api/health`

Admins can simulate a branch or warehouse with:

- `x-simulate-scope-type`
- `x-simulate-scope-id`

## Branch company details setting

Admins can allow or hide the companies **eye / details** icon for branch (cashier) users.

- Column: `branches.allow_company_view` (`TINYINT(1)`, default `1`)
- Setting key in API: `allowCompanyView`
- Admin UI: Simplified Settings → Branch → Company Management → Allow Company Details

If the column is missing, run:

```bash
node scripts/add-allow-company-view.js
```

## Layout

```
config/         database and app config
controllers/    request handlers
middleware/     auth, RBAC, permissions
models/         MySQL models
routes/         Express routes
scripts/        one-off DB / data jobs
services/       background jobs and domain logic
uploads/        uploaded files (not committed)
```

## Deploy

1. Upload the app (without `node_modules` and `.env`).
2. Set production `.env` on the server.
3. `npm install --production`
4. `npm run cpanel` or start with the host’s Node app manager.
5. Point the frontend `CORS` / API URL at this host.

## License

MIT
