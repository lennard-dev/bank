# BankMCP™

**Your bank, in Claude.** Read-only, self-hosted, one user.

BankMCP™ is not a bank. It is a small open-source server you host yourself
(package name `bank-mcp`). It connects to your banks
through [Enable Banking](https://enablebanking.com), which wraps 2,700+
European banks in one PSD2 API, and exposes them to Claude as an MCP
connector. Read-only, no payments, no third party holding your data.

> "Has the invoice from Acme been paid?" · "What did we spend on groceries in
> August?" · "Which subscriptions am I paying for, and what do they cost per
> year?" · "Tell me when my balance drops below 5,000."

## How it works

```
Claude ──OAuth──▶ your BankMCP™ server ──JWT──▶ Enable Banking ──PSD2──▶ your bank
```

- **Claude** talks to your server as a custom connector. You sign in once with
  a password; tokens handle the rest.
- **Your server** holds the Enable Banking application key, the bank consents
  and your account ids. It never stores balances or transactions and sends no
  telemetry.
- **Enable Banking** is the licensed provider. You log in at your bank's own
  site to approve access; nobody sees your bank credentials.

## Setup

You need an Enable Banking account (free), a place to run a container with a
public https address, and about fifteen minutes.

### 1. Deploy

Any container host works. The server needs a persistent volume at `/data`
and a public https address; it asks you for everything else in the browser.

**Railway:** New Project, Deploy from GitHub repo, pick this repo. Add a
volume mounted at `/data` and generate a domain (Settings, Networking, port
8080). The Dockerfile and [railway.json](railway.json) are picked up
automatically, and the server learns its own address from Railway.

**Docker Compose on your own box:** `docker compose up -d`, then put a TLS
terminator in front (Caddy needs two lines:
`YOUR-HOST { reverse_proxy localhost:8080 }`) and set `BASE_URL` to the
public address. Fly.io works like Railway: volume at `/data`, the app name
gives the address.

Open the address. A fresh server shows a setup page.

### 2. Register an Enable Banking application

The setup page lists the exact values Enable Banking's form asks for: the
redirect URL, a description for the consent screen, and the privacy and
terms URLs, all pointing at your server. At
<https://enablebanking.com/cp/applications> create an application with them:

- Environment: **Production** for your real accounts, **Sandbox** for test
  data (see *Going live* below for the production rules).
- Keep "generate private key" selected. A `.pem` file downloads once when you
  save; that is the key. The application id (a UUID) is shown after saving.

### 3. Finish setup

Back on the setup page: paste the application id, choose the `.pem` file, pick
a password of twelve characters or more. Everything is stored on the volume,
and the page turns into a status page showing the connector URL for Claude.

Prefer configuration by environment? Set these and the setup page never
appears:

| Variable | Value |
|---|---|
| `EB_APP_ID` | the application id |
| `EB_PRIVATE_KEY` | the `.pem` contents, base64: `base64 -i app.pem \| tr -d '\n'` |
| `ADMIN_PASSWORD_HASH` | output of `npm run hash-password` (or set `ADMIN_PASSWORD`) |
| `BASE_URL` | `https://YOUR-HOST` (Railway and Fly set this for you) |
| `DEFAULT_COUNTRY` | your country code, e.g. `DK` |
| `APP_NAME` | optional, the name shown on the sign-in and status pages (default `BankMCP™`) |

Optional: `NOTIFY_WEBHOOK_URL` for watch notifications and sign-in alerts (a
Slack incoming webhook works). Full list in [.env.example](.env.example).
`npm run check` verifies a configuration from a terminal.

### 4. Add the connector in Claude

In claude.ai (or the desktop app): **Settings → Connectors → Add custom
connector**. Name it `BankMCP™`, paste `https://YOUR-HOST/mcp`, save, then click
**Connect**. Your server shows a password page; enter the admin password. That
is the only login you will do.

In Claude Code:

```bash
claude mcp add --transport http bank https://YOUR-HOST/mcp
```

then run `/mcp` inside Claude Code to sign in.

### 5. Connect your bank

In Claude, say **"connect my bank"** (or use the `connect-bank` prompt). Claude
looks up your bank, gives you a link, you log in at the bank and approve, and
the accounts appear. Consents last up to 180 days; Claude tells you when one
is about to expire and the same conversation renews it.

Give accounts labels ("Everyday", "Joint expenses", "Mortgage") when Claude
suggests them. Every tool accepts labels instead of ids.

### Optional: several named people instead of one password

By default one admin password guards the connector. To let a small team use
one server without sharing a secret, switch sign-in to Google:

1. In Google Cloud Console create an OAuth client (type *Web application*)
   with the authorized redirect URI `https://YOUR-HOST/auth/google/callback`
   (the status page shows the exact value).
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
   `ALLOWED_EMAILS=anna@example.org,ben@example.org` and restart.

The login page then shows *Sign in with Google*, the password form is off,
and only the listed addresses get in. Each token remembers who signed in;
take an address out of `ALLOWED_EMAILS` and that person's access stops at
once, without logging anyone else out. Sign-in notifications name the person.
The admin password is still needed for the first-run setup page.

## Going live with your own accounts

Enable Banking's production environment normally requires a contract, but it
has a **restricted mode** for accessing *your own* accounts, explicitly allowed
for individual non-commercial use. After registering a Production application:

1. On the (Inactive) application click **Activate by linking accounts**.
2. Log in at your bank and approve. Repeat for each bank you want.
3. The application becomes active and the API only ever returns accounts you
   linked this way.

Read the *Restriction of Use* section of Enable Banking's
[Terms of Service](https://enablebanking.com/terms-of-service/) before you
rely on it: restricted mode is for your own accounts, not for offering a
service to others. This project does not change those terms.

## What you get

**Tools** (all read-only):

| Tool | What it does |
|---|---|
| `list_banks`, `start_consent`, `consent_status`, `disconnect_bank` | connect and manage banks |
| `list_accounts`, `set_account_label` | accounts with booked balances; your own names for them |
| `get_balances` | booked and available balance for one account |
| `get_transactions` | signed amounts, one counterparty, one description; paginated |
| `create_watch`, `list_watches`, `delete_watch`, `check_watches` | background rules with webhook notifications |

**Prompts**: `connect-bank`, `monthly-summary`, `build-budget`,
`subscription-audit`, `unusual-transactions`.

**Watches** run on the server. Rules: balance below or above an amount, a
single debit over an amount, an incoming or outgoing payment matching a name,
and "tell me if this payment has not arrived by this date". Accounts are
checked at most four times a day, the PSD2 limit for unattended access.
Notifications go to `NOTIFY_WEBHOOK_URL` as a Slack message or a JSON POST.

Enable Banking's own webhooks cover payment initiation only, so account data
is polled. There is no way around that under PSD2.

## Claude Code plugin

The repository is also a Claude Code plugin marketplace. The `bank` plugin
bundles the connector entry and a skill that encodes how to work with the
data: an account map, categorisation rules, the monthly review format and when
to create watches.

Point it at your server, then install:

```bash
export OPENBANK_URL=https://YOUR-HOST/mcp   # put this in your shell profile
```

```
/plugin marketplace add noskillish/bank
/plugin install bank@bank
```

Then `/mcp`, select `bank`, Authenticate, and enter your password. No
organisation admin is involved; plugins are per user.

The skill lives at [plugin/skills/bank/SKILL.md](plugin/skills/bank/SKILL.md).
Copy it into your own skills to fill in the account map and your merchant
rules. The server stays generic; your rules stay yours.

## Running it on your own machine

The server can also run locally over stdio, with no OAuth, for Claude Code in
this directory. The repository ships a `.mcp.json` for that:

```bash
npm install
cp .env.example .env    # EB_APP_ID, EB_PRIVATE_KEY_PATH, ADMIN_PASSWORD
npm run dev             # http server, for the bank redirect
```

Production applications require an https redirect URL even locally. Create a
certificate with [mkcert](https://github.com/FiloSottile/mkcert), set
`TLS_CERT_PATH`, `TLS_KEY_PATH` and `BASE_URL=https://localhost:8080`, and
register `https://localhost:8080/callback` as a redirect URL.

## Local models (experimental)

The server does not care which model asks. `npm run chat` bridges an
[Ollama](https://ollama.com) model to the same tools over stdio, so no AI
vendor ever sees a transaction:

```bash
ollama pull qwen3:8b
npm run chat -- "what's my balance?"
```

Measured on a MacBook Air with 24 GB: correct per-account balances, a wrong
total, ten minutes per answer. An 8B model is not yet trustworthy with money;
a 30B-class model on a machine with a real GPU is where it gets useful. Any
MCP client with tool calling (LM Studio, Goose, Jan) can also point at
`node src/stdio.ts` directly. Enable Banking still sits between you and the
bank either way; that part is regulated and unavoidable.

## Security notes

- The server is a complete OAuth 2.1 authorization server with one user.
  Discovery, dynamic client registration and PKCE come from the MCP SDK;
  tokens are stored hashed; five wrong passwords lock an address out for
  fifteen minutes.
- State is one JSON file in `DATA_DIR`: consents, account ids, watches and
  OAuth tokens. Back it up if you care about not re-consenting; delete it to
  forget everything.
- Only clients that redirect back to `claude.ai`, `claude.com` or localhost
  can register (`ALLOWED_REDIRECT_HOSTS`), so a phishing link cannot route
  your sign-in to another site. The sign-in page also names the host you will
  be sent back to.
- Anyone with the admin password can read your accounts. Use a long one.
  Every successful sign-in is logged and, if `NOTIFY_WEBHOOK_URL` is set,
  sent to you as a message. A sign-in you did not make is your alarm.
- Changing `ADMIN_PASSWORD_HASH` (or `ADMIN_PASSWORD`) and restarting logs
  every client out. That is the kill switch. Revoking the consents at your
  bank, or deleting the state file, is the step beyond it.
- There are no payment tools and none will be added. Payments need a
  licensed PISP and a very different security model.

## Commands

```bash
npm start              # http server (reads env from the environment)
npm run dev            # same, with reload and .env
npm run check          # verify config and the Enable Banking application
npm run hash-password  # produce ADMIN_PASSWORD_HASH
npm run watch -- --force   # run all watches once, print what fired
npm test               # unit tests (node:test)
npm run typecheck
```

Requires Node 24 or newer (runs TypeScript directly, no build step).

## Layout

```
src/server.ts         Express: /mcp behind OAuth, OAuth endpoints, /callback, status page
src/auth.ts           single-user OAuth provider, password login page
src/mcp.ts            McpServer factory (tools + prompts + instructions)
src/tools.ts          the MCP tools
src/prompts.ts        the MCP prompts
src/watcher.ts        background rule checks and notifications
src/enablebanking.ts  JWT signing and a thin typed API client
src/store.ts          the JSON state file
src/data.ts           shaping balances and transactions for an assistant
src/stdio.ts          local stdio entry point
src/cli.ts            check, hash-password, watch
plugin/               Claude Code plugin with the bank skill
```

## What this is, and is not

BankMCP™ is software, not a service. There is no hosted BankMCP™, no account to sign
up for, and nobody but you ever touches your server, your key or your bank
consents. Each person who uses it deploys their own copy and is the sole
operator of that copy: they register their own Enable Banking application,
accept Enable Banking's terms themselves, and are responsible for their own
hosting, password and security.

The authors publish the code and nothing else. They do not run any instance
for others, receive no data, and are not affiliated with Enable Banking,
Anthropic or any bank. BankMCP™ is not a bank, does not hold money, and gives no
financial advice. The software is provided as is, without warranty of any
kind, under the MIT licence below.

## License

MIT
