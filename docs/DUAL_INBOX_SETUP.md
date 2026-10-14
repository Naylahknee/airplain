# AirPlain: Gmail and Microsoft 365 inbox authorization

Status: draft. Do not merge until the production D1 migration and OAuth setup are completed.

AirPlain's approved-customer preflight offers Gmail and Microsoft Outlook/Microsoft 365. Either verified connection satisfies the first-inbox step. Both can be connected. Authorization is read-only and does not start email processing.

## Microsoft setup

1. Register AirPlain as a Web application in Microsoft Entra admin center > App registrations.
2. Select supported accounts: both organizational directories and personal Microsoft accounts.
3. Register the web redirect URL using the exact AirPlain public origin, followed by /api/setup/microsoft/callback.
4. Grant Microsoft Graph delegated scopes User.Read and Mail.Read. Offline access is requested during the authorization flow. Do not add send or write permissions.
5. Configure MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in the Worker settings, alongside PUBLIC_BASE_URL and OAUTH_ENCRYPTION_KEY.
6. Verify sign-in against both Outlook.com and Microsoft 365 work/school test users. Some Microsoft organizations require administrator approval for consent.

The server uses OAuth authorization code with PKCE, one-use state, a matching approved AirPlain customer session, an encrypted refresh token, and a Graph profile and inbox-folder check. No email messages are fetched by the connection step.

## Gmail setup

Google OAuth requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, an exact redirect URL ending /api/setup/gmail/callback, and an approved Gmail API OAuth consent screen. The Gmail read-only scope may require Google verification for public use.

## Important limits

- Disconnecting Microsoft deletes AirPlain's stored authorization. A Microsoft account owner or administrator may separately revoke consent in Microsoft app permissions.
- Disconnecting Gmail also attempts Google-side token revocation.
- The four preflight steps are not payment activation or live mail automation. No actual messages are imported or sent.
- Apply migrations/0003_customer_onboarding.sql to the correct production D1 database before deploying this branch.
- Do not paste any provider credentials or secret values into code, GitHub, or conversations.

Microsoft references:
https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
https://learn.microsoft.com/en-us/graph/permissions-reference
