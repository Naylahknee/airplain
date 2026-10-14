# AirPlain: approved-customer onboarding (staged, NOT yet live)

AirPlain accepts **seat applications first**. No payment, subscription, inbox access, or confirmed seat is created by applying.

## Journey

1. The owner visits /admin/, enters the private AIRPLAIN_ADMIN_KEY, reviews applications, and chooses approve or decline.
2. Approval creates a seven-day, one-use invitation link. The link appears only once. The owner copies it and sends it privately; there is **no automatic email sender**.
3. An approved customer visits /setup/ using the invitation. The site exchanges the link for a Secure, HttpOnly, SameSite=Lax session cookie (30 days). Raw invitation tokens are not stored.
4. Customer connects Gmail, saves message-routing preferences, explicitly approves safe AI rules, and runs a **real Workers AI sample**.
5. Finishing preflight does **not** activate paid billing, inbox polling, importing, or customer replies.

The public booking confirmation shows the **preflight preview locked until approval**. It does not include checkboxes that claim setup happened.

## Database: required BEFORE merge/deploy

Back up the production airplain D1 database, then apply migration **migrations/0003_customer_onboarding.sql** to that same production database. It only creates onboarding tables and indexes. It does not alter existing seat applications.

Wrangler command (authenticated environment):

    npx wrangler d1 migrations apply airplain --remote

Alternatively execute the SQL inside Cloudflare D1 Console; don't apply the same migration twice using different methods. Verify the onboarding_profiles, onboarding_invites, onboarding_sessions, onboarding_oauth_states, and onboarding_events tables exist.

**Do not merge this branch into production until migration 0003 is applied successfully.**

## Cloudflare Worker settings and secrets

Configure these in Cloudflare Workers & Pages / airplain / Settings / Variables and Secrets:

| Name | Type | Purpose |
| --- | --- | --- |
| AIRPLAIN_ADMIN_KEY | secret | New cryptographically strong admin-only password/key, at least 32 characters |
| GOOGLE_CLIENT_ID | secret / variable | OAuth 2.0 web client ID |
| GOOGLE_CLIENT_SECRET | secret | OAuth 2.0 client secret |
| OAUTH_ENCRYPTION_KEY | secret | Base64 encoding of **32 random bytes** for AES-256-GCM token encryption |
| PUBLIC_BASE_URL | variable | Your exact production origin, starting with https://, with no trailing path |

**Never share the secrets in chat or store them in GitHub.**

Create a Google Cloud OAuth consent screen and Web application OAuth client, enable Gmail API and add the exact authorized callback:

    https://YOUR_AIRPLAIN_DOMAIN/api/setup/gmail/callback

Gmail connection asks for **gmail.readonly** and **userinfo.email** scopes through Google OAuth, including offline permission for a refresh token. Gmail readonly is a restricted Google scope; external authorization may require Google verification and a security assessment. In testing mode, only preauthorized test accounts can connect. The UI does not pretend Gmail is connected if settings are absent or OAuth is not completed.

Setting Worker secrets may trigger a deployment: do this only after the migration is complete.

## What is functional after configuration

- Administrator can view latest 100 applications, approve/decline them, and issue fresh invitations.
- One-use invitations are SHA-256 hashed in D1 and expire after seven days.
- Secure approved-customer sessions are stored hashed in D1 and checked with each API call.
- Gmail OAuth uses authorization code, PKCE, state protection, Gmail profile verification, AES-GCM-encrypted refresh token storage, and revoke/disconnect.
- Routing preferences and customer-approved rules are saved in D1; pilot rules require human review and prohibit automatic replies.
- Fictional sample messages go to the existing AirPlain decision engine. The fourth step completes only with a real Workers AI result (not stub fallback).
- No raw sample message text is stored. No customer messages are fetched, sent, or automatically handled.

## Deliberately still unavailable

- Sending invitation emails automatically; the owner copies and sends the link.
- Microsoft/Outlook connections (Gmail first).
- Continuous inbox synchronization, storage of real messages, customer replies, automatic scheduling or live message routing.
- Paid subscriptions, automated seat approvals, live activation, or public password-reset flows.

Those live features require further security and product work. Setup completion cannot imply they already work.

## Before production

1. Review the implementation in its pull request and run npm test.
2. Apply migration 0003 to production D1.
3. Set the Worker admin secret, Gmail OAuth credentials, encryption key, and URL.
4. Register Google's exact redirect URL and test with an approved OAuth test user.
5. Test approval, one-use invitation, Gmail connection, saved preferences, approval of rules, sample AI run, and disconnect.
6. Inspect older global settings endpoints for production authorization before accepting real customer messages.
7. Obtain explicit owner approval before merging or deploying to main.

URLs: public seat request is /, owner review is /admin/, approved customer onboarding is /setup/.
