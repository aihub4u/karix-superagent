# Karix Superagent — WhatsApp Template Builder

Self-serve platform for client teams (MDH Spices, RedTag, Meesho, etc.) to
create WhatsApp Business templates against the **Karix RCM Template API**
through a ChatGPT-style chat interface or bulk Excel upload — no knowledge
of Meta's template JSON required.

## Architecture

```
public/index.html        one-page chat UI + Excel upload panel, no build step
server/index.js          Express app, static file serving, route wiring
server/routes/chat.js        POST /api/chat        — conversational template builder (OpenAI + function calling)
server/routes/templates.js   /api/templates/*       — submit/list/delete/edit, tenant-scoped
server/routes/bulkImport.js  /api/bulk-import/*     — Excel parsing, AI row normalization, rate-limited submission
server/services/karixClient.js     Karix RCM API adapter (create/get/edit/delete/upload media)
server/services/templateValidator.js  Pre-submission validation against Karix/Meta rules
server/services/crypto.js          AES-256-GCM encrypt/decrypt for stored Karix tokens
server/db/schema.sql               Multi-tenant Postgres schema
server/prompts/templateAgentSystemPrompt.md   System prompt for the chat agent
```

**Multi-tenant model:** each client (org) has one or more `waba_accounts`
rows (WABA ID + encrypted Karix token + region). All queries are scoped by
`organization_id`. `req.auth` is expected to carry `{ organizationId,
userId, role }` — wire in real session/JWT auth before going live; the
current `server/index.js` middleware is a dev stand-in reading headers.

**Auto-submit flow (per your call):** the chat agent drafts a spec → the
UI renders a WhatsApp-style live preview + runs client-visible validation
→ user clicks "Approve & submit" → `/api/templates/submit` re-validates
server-side and calls Karix directly. No separate human review step.
Because there's no safety net after that click, `templateValidator.js`
is the thing standing between a client and a wasted daily/monthly edit
quota — extend it as you hit real-world edge cases.

## What's confirmed vs. what needs a live test

Built directly from the 60-page Karix RCM Template API doc you provided —
endpoints, field names, category rules, and character/rate limits are
taken verbatim from there. Two things aren't documented and need
confirming against a sandbox call before production:

1. **Auth header name** — most examples show `Authentication: Bearer …`,
   a couple show `Authorization`. Currently set to `Authentication` in
   `karixClient.js` (`AUTH_HEADER_NAME` constant) — flip in one place if
   you get 401s.
2. **Success/error response body shape** — the docs list status codes
   (200/201, and error codes 1001–1010) but not the JSON shape of a
   successful create response. `karixClient.js` and the routes that use
   it don't assume a shape; they try `body.id / body.template_id /
   body.templateId` when looking for the new template's ID. Once you see
   a real response, tighten that up in `templates.js` and `bulkImport.js`.

## Setup

1. **Database** (Supabase or Neon, matching your existing pattern):
   ```
   npm install
   # set DATABASE_URL in .env
   npm run migrate
   ```
2. **Environment** — copy `.env.example` to `.env` and fill in
   `OPENAI_API_KEY`, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`.
3. **Connect a WABA account** — no SQL/Postman needed anymore. Set
   `ADMIN_SETUP_SECRET` in your env vars (any password-like string), deploy,
   then open the app and click **"Setup WABA connection"** in the header.
   Enter the admin secret, client name, real WABA ID, region, and Karix
   bearer token — this calls `POST /api/admin/quick-setup`, which
   upserts the `organizations` and `waba_accounts` rows and encrypts the
   token server-side before it touches the database. The browser then
   remembers the connection (`localStorage`) across reloads. Use the same
   panel again with a different org name to onboard a second client, or
   the same name to update an existing one's token.
   (The old manual path — SQL Editor inserts + `/api/admin/encrypt-token`
   via Postman — still works and is documented at the bottom of this
   section if you ever need to script bulk onboarding instead.)
4. **Run locally**: `npm run dev`, open `http://localhost:3000`. Once
   connected via the Setup panel, the browser sends `x-org-id`/`x-user-id`
   headers automatically — the `DEV_ORG_ID`/`DEV_USER_ID` env vars in
   `server/index.js`'s middleware are now just a fallback for direct API
   testing (curl/Postman) without the UI.
5. **Deploy on Render**: push to GitHub, connect the repo, set the same
   env vars in the Render dashboard, build command `npm install`, start
   command `npm start` — matches your existing Node/Express + Render
   pattern on other projects.

## What's intentionally left as a next step

- Real auth (session/JWT) + an account-switcher UI for multi-WABA orgs —
  currently a dev header stand-in.
- Persisting chat sessions to `chat_sessions` / `chat_messages` (the route
  is stateless-per-request right now; the frontend resends history).
- Swapping the in-process bulk-import loop for a proper queue (BullMQ/Redis
  — you've already used this pattern on the WhatsApp engagement platform).
- A status-sync job that polls `GET /template/{wabaId}/{templateId}` (or
  ingests Karix's webhook, if the `webhook.url` you pass on create fires
  approval/rejection callbacks — worth confirming with Karix support)
  to move templates from `submitted` → `approved`/`rejected` automatically.
- Media upload UI for HEADER image/video/document components (backend
  route `POST /api/templates/media/:wabaAccountId` is ready; needs a file
  picker wired into the chat flow before a HEADER with format IMAGE/VIDEO/
  DOCUMENT can be completed).
