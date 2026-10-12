# Seejas 3D Prints

## Requirements
- Node.js 20 or newer

## Setup (Windows PowerShell)
1. Open PowerShell in this folder.
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env`.
4. Edit `.env` and set a unique `SESSION_SECRET` (32+ characters), `ADMIN_EMAIL`, and `ADMIN_PASSWORD` (12+ characters).
5. Start the server: `npm start`
6. Open `http://localhost:3000`.

Pages: `/`, `/login.html`, `/account.html`, `/admin.html`.

The initial admin is created only if `ADMIN_EMAIL` does not already exist. If changing the admin password after first setup, use a password-reset/database procedure; editing `.env` alone does not update the existing password hash.

## Notes
- Product images should be HTTPS URLs or paths served from the `site` folder.
- Checkout currently supports Cash on Delivery only. No online card/payment processing is included.
- The quote form opens the visitor's email app; selected files must be attached manually.
- Never publish `.env` or the `data` folder.
