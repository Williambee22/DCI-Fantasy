# CorpsDraft

A Railway-ready fantasy drum corps web application. Players create accounts, create or join private leagues, and draft unique **corps + caption + subcaption** assets such as:

- Bluecoats — Visual Proficiency — Achievement
- Carolina Crown — Brass — Content
- Phantom Regiment — Percussion — Achievement

The league creator is the commissioner. A separate site-wide head admin enters event recap scores once, and those scores automatically recalculate every fantasy league.

## Included features

- Email/password accounts with secure password hashing
- Site-wide `ADMIN` role controlled by `HEAD_ADMIN_EMAIL`
- Season-specific private leagues with invite codes
- Commissioner settings with saved or randomized snake-draft order
- Live draft room that refreshes every 2.5 seconds
- Unique asset enforcement inside each league
- Draft pause, resume, and reset controls
- Global event and score administration
- Fantasy standings calculated from all finalized events
- Corps activation/deactivation controls
- PostgreSQL-backed sessions and data
- CSRF protection, secure cookies, Helmet headers, and authentication rate limiting
- Railway health check and graceful shutdown
- Optional, permission-gated DCI recap importer

## Scoring model

Each draftable asset contains:

1. A corps
2. A caption
3. One of that caption's two subcaptions

The seeded captions are:

| Code | Caption | First subcaption | Second subcaption |
|---|---|---|---|
| GE1 | General Effect 1 | Repertoire | Performance |
| GE2 | General Effect 2 | Repertoire | Performance |
| VP | Visual Proficiency | Content | Achievement |
| VA | Visual Analysis | Composition | Achievement |
| CG | Color Guard | Content | Achievement |
| BRASS | Brass | Content | Achievement |
| MA | Music Analysis | Content | Achievement |
| PERC | Percussion | Content | Achievement |

A fantasy team's points are the sum of the drafted subcaption scores across every finalized event in that league's season year. Drafted assets immediately reflect score edits made by the head admin.

## Local setup

Requirements:

- Node.js 20 or newer
- PostgreSQL

```bash
cp .env.example .env
npm install
npm start
```

The app creates its database tables and seeds captions/corps at startup.

## Railway deployment — GitHub method

1. Put this folder in a GitHub repository.
2. In Railway, create a new project and choose **Deploy from GitHub repo**.
3. Add a PostgreSQL service to the Railway project.
4. In the app service, add these variables:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=<a long random string>
HEAD_ADMIN_EMAIL=<your login email>
NODE_ENV=production
```

Optional bootstrap variables:

```text
ADMIN_BOOTSTRAP_USERNAME=headadmin
ADMIN_BOOTSTRAP_PASSWORD=<temporary strong password>
```

If the admin account does not exist, those optional variables create it during startup. Remove `ADMIN_BOOTSTRAP_PASSWORD` after the account is created.

5. Deploy the service.
6. In the service's **Networking** settings, generate a public domain.

Railway detects the Node application automatically. `railway.json` configures `npm start` and the `/health` endpoint.

## Railway deployment — CLI method

Install and authenticate the Railway CLI, then from this directory run:

```bash
railway init --name corpsdraft
railway add -d postgres
railway add -s corpsdraft-app
SESSION_SECRET_VALUE="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
railway variable set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  "SESSION_SECRET=$SESSION_SECRET_VALUE" \
  "HEAD_ADMIN_EMAIL=you@example.com" \
  "NODE_ENV=production"
railway up
railway domain
```

Depending on your selected Railway service names, you may need to set `DATABASE_URL` in the dashboard instead of using the exact reference shown above.

## First-use workflow

1. Register using the exact email stored in `HEAD_ADMIN_EMAIL`.
2. Open **Head Admin**.
3. Add or deactivate corps as needed.
4. Select **Add score event**.
5. Enter the event name, date, and location.
6. Enter subcaption scores in the grid and save.
7. Create a league from the dashboard and send the invite code to players.
8. Set roster size and start the randomized snake draft.

## DCI automatic score import

The application includes an importer scaffold, but it is disabled by default.

DCI's published copyright policy states that event results, score reports, and recaps may not be reused without express written permission. Obtain permission before activating automated import.

After permission is obtained, set:

```text
DCI_IMPORT_ENABLED=true
DCI_PERMISSION_CONFIRMED=true
DCI_CONTACT_EMAIL=you@example.com
DCI_SOURCE_YEAR=2026
DCI_SYNC_CRON=15 * * * *
```

The importer:

- Accepts official `https://www.dci.org/scores/recap/...` URLs
- Uses an identifiable user agent
- Imports standard single-panel recap tables
- Upserts events, corps, and scores
- Runs idempotently based on event slug and score uniqueness
- Can discover recap links from the DCI scores page on an hourly schedule

Important limitations:

- DCI may change its page markup at any time.
- JavaScript-rendered links may not be discoverable from server-side HTML.
- Double-panel championship recaps may need a parser extension.
- Manual score entry remains the reliable fallback.

## Environment variables

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | PostgreSQL connection URL |
| `SESSION_SECRET` | Production | Session signing secret |
| `HEAD_ADMIN_EMAIL` | Recommended | Email that receives site-wide admin access |
| `ADMIN_BOOTSTRAP_PASSWORD` | No | Creates the initial admin account |
| `ADMIN_BOOTSTRAP_USERNAME` | No | Username for the bootstrap admin |
| `NODE_ENV` | Recommended | Set to `production` on Railway |
| `PORT` | No | Railway supplies this automatically |
| `DCI_IMPORT_ENABLED` | No | Enables the DCI connector |
| `DCI_PERMISSION_CONFIRMED` | No | Confirms permission was obtained |
| `DCI_CONTACT_EMAIL` | Connector | Contact in importer user agent |
| `DCI_SOURCE_YEAR` | No | Season used for discovery |
| `DCI_SYNC_CRON` | No | Cron expression for sync |

## Production notes

- PostgreSQL is used instead of SQLite, so no Railway volume is required.
- Scores are stored globally, not duplicated per league.
- The app uses database transactions and row locking for draft picks.
- Only one asset can be drafted once per league.
- Multiple app instances are safe for drafting because the league row is locked during each pick.
- Scheduled imports are best run from one app instance. If horizontally scaling, move imports to a dedicated Railway worker service.

## Tests

```bash
npm test
npm run check
```

The included tests verify snake-draft order and round calculations.
