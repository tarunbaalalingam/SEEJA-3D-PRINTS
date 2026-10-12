# Seejas 3D Prints — Netlify deployment notes

## Important: do not use this SQLite configuration for a live store yet

This package adds a Netlify Functions adapter so the Express API can be invoked by Netlify. The existing application uses `better-sqlite3` and SQLite files for users, products, carts, orders, and sessions. Netlify Functions have ephemeral local storage and can cold-start in separate instances, so those SQLite files and SQLite-backed sessions are **not durable or shared in production**. A deploy may build, but this is not production-safe for real customer accounts or orders until the database/session storage is migrated to a persistent shared service.

## Netlify configuration

- Build command: `npm install`
- Publish directory: `site`
- Functions directory: `netlify/functions`
- Node version: use Node 20 or a version compatible with the native `better-sqlite3` package.

Set these in Netlify Site configuration → Environment variables (never commit them):

- `SESSION_SECRET`: random secret of at least 32 characters
- `ADMIN_EMAIL`: intended admin email
- `ADMIN_PASSWORD`: strong password of at least 12 characters
- `ADMIN_NAME`: optional
- `NODE_ENV`: `production`

## Before taking real orders

Migrate the SQLite schema and queries to a persistent database (for example managed PostgreSQL), use a shared persistent session store or replace sessions with a secure token strategy, then test registration, login/logout, catalogue, cart, stock checks, checkout, order history, and admin order status changes on a deployed preview. The current checkout supports Cash on Delivery only.

For the least-risk route, deploy the static frontend to Netlify and keep the existing Express backend on a Node host that supports a persistent disk, or complete the database migration before moving the API to Netlify Functions.
