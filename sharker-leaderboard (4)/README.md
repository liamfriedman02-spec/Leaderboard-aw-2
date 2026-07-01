# Sharker — Live Launch Leaderboard

Launch a casino, get on the board, win an iPad. A live leaderboard that shows every
platform launched from `sharker.com/partners` the instant it happens — newest first,
no points, every launcher entered into the iPad giveaway.

- **Public board** — `/`
- **Admin panel** — `/admin`
- **Launch endpoint your site calls** — `POST /api/launch`
- **Live updates** — pushed over Server‑Sent Events (no page refresh)
- **Database** — SQLite file (`sharker.db`), built into Node 22 (no native build step)

---

## Run it

Requires **Node.js 22+**.

```bash
npm install
ADMIN_KEY="choose-a-strong-key" npm start
```

Then open:
- Public board → http://localhost:3000/
- Admin panel → http://localhost:3000/admin  (enter your `ADMIN_KEY`)

## Environment variables

| Variable      | Default          | Purpose                                                        |
|---------------|------------------|----------------------------------------------------------------|
| `PORT`        | `3000`           | Port to listen on                                              |
| `ADMIN_KEY`   | `sharker-admin`  | **Change this.** Required to open the admin panel and its APIs |
| `LAUNCH_KEY`  | *(unset)*        | If set, `POST /api/launch` requires header `x-launch-key`      |
| `CORS_ORIGIN` | `*`              | Restrict which site may call the API (e.g. `https://sharker.com`) |

---

## Connect it to sharker.com

When a user launches a casino on your site, fire one request to the launch endpoint.
It appears on the board instantly for everyone watching.

```js
// Run this on sharker.com the moment a casino is launched:
fetch("https://YOUR-LEADERBOARD-HOST/api/launch", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    // "x-launch-key": "your-launch-key"   // only if LAUNCH_KEY is set
  },
  body: JSON.stringify({
    platformName: "Reef Royale",           // required
    ownerName:    "Marina Cole",
    country:      "UK",
    email:        "owner@example.com",      // private — never shown publicly
    wallet:       "0x…",                    // private — never shown publicly
    platformUrl:  "https://reef.example",
    launchTime:   new Date().toISOString()  // optional; defaults to now
  })
});
```

`email` and `wallet` are stored but **never returned on the public board** — they only
appear in the admin panel.

---

## Admin panel

Unlock with your `ADMIN_KEY`, then:
- **Add a launch** manually
- **Edit** any launch's details
- **Delete** fake / test launches
- **Pick iPad winner** — draws one entry at random from everyone on the board

## API reference

| Method | Path                  | Auth        | Description                                  |
|--------|-----------------------|-------------|----------------------------------------------|
| POST   | `/api/launch`         | optional*   | Add a launch (this is what your site calls)  |
| GET    | `/api/launches`       | public      | All launches, newest first (no email/wallet) |
| GET    | `/api/winner`         | public      | Current drawn winner                         |
| GET    | `/api/stream`         | public      | SSE live feed (`launch`/`update`/`delete`/`winner`) |
| GET    | `/api/admin/launches` | `x-admin-key` | Full records incl. email/wallet            |
| PUT    | `/api/launch/:id`     | `x-admin-key` | Edit a launch                              |
| DELETE | `/api/launch/:id`     | `x-admin-key` | Delete a launch                            |
| POST   | `/api/draw`           | `x-admin-key` | Randomly pick one winner                    |

\* open unless `LAUNCH_KEY` is set.

---

## Deploy

Any host that runs Node 22 works (Render, Railway, Fly.io, a VPS, etc.).
- Start command: `npm start`
- Set `ADMIN_KEY` (and optionally `LAUNCH_KEY`, `CORS_ORIGIN`).
- Give it a **persistent disk** so `sharker.db` survives restarts.

## Notes
- Scale is fine for a conference: SQLite comfortably handles thousands of entries.
- For the live winner draw on stage, keep the public board open — the winner banner
  appears on it automatically when you press **Pick iPad Winner** in admin.

---

## Connect your real launch flow (Supabase)

Files in `integration/`:
- `supabase-launches.sql` — creates the `launches` table (run it in the Supabase SQL editor).
- `leaderboard-hook.js` — call `registerLaunch(...)` from your platform-creation
  success handler on `sharker.com/partners`.

**Server-side env for your sharker.com app:**

| Variable                     | Purpose                                            |
|------------------------------|----------------------------------------------------|
| `SUPABASE_URL`               | Your Supabase project URL                          |
| `SUPABASE_SERVICE_ROLE_KEY`  | Service role key (server-side only — keep secret)  |
| `LEADERBOARD_URL`            | Deployed board URL, e.g. `https://board.sharker.com` |
| `LEADERBOARD_LAUNCH_KEY`     | Must match `LAUNCH_KEY` on the board (optional)    |

**Usage — the moment a platform is created:**

```js
import { registerLaunch } from "./leaderboard-hook.js";

// inside your "platform created" success handler (server-side):
await registerLaunch({
  platformName,   // required
  ownerName,
  country,
  email,          // stored in Supabase; never shown on the public board
  wallet,         // stored in Supabase; never shown on the public board
  platformUrl,
  // launchTime defaults to now if omitted
});
```

It logs `Platform created successfully` → `Sending launch to leaderboard` →
`Launch saved to leaderboard`, and on failure `Leaderboard API error` with the full
error. Run it on the server so the service role key stays secret.

> Note: this writes the launch to **both** the leaderboard API and Supabase. If you
> want a single source of truth, the board's API can instead read/write Supabase
> directly so your app only calls `/api/launch` — ask and I'll switch it over.
