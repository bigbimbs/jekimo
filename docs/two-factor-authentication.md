# Two-factor authentication

Jekimo supports authenticator apps (TOTP) and single-use recovery codes. Users can opt in when the instance policy is optional. An instance admin can require everyone to enroll. SMTP is not needed.

## Operator setup

1. Apply migrations, including `0010_two_factor.sql`, before starting the new API version.
2. Generate a 32-byte key with `openssl rand -base64 32`. Put the result in `JEKIMO_MFA_ENCRYPTION_KEY` in your private `.env`; never commit it or paste it into logs. The production and development Compose files pass it to the API only.
3. Restart every API process with the same key. Keep server time synchronized. Serve the dashboard over HTTPS outside localhost.
4. Back up the key in a secret manager separately from PostgreSQL. Losing it makes stored authenticator secrets unusable; a database backup alone is insufficient. Do not replace it as a routine credential rotation: existing ciphertext requires the original key. Automatic key rotation is not implemented.

With no key configured, password-only accounts remain usable while policy is optional, but enrollment is unavailable. An enrolled account cannot complete a new sign-in if its key is missing or incorrect. Restore the original key, or use the explicit operator recovery procedure below.

## User enrollment

Open the account menu and choose **Account security** (`/security`). Choose **Set up authenticator**, confirm your current password, and scan the QR code using your authenticator app. A manual setup key is also shown. The QR image is generated in your browser; no secret is sent to an external QR service.

Enter the current six-digit code and choose **Verify and enable** within ten minutes. Save the eight recovery codes before closing the result. They are shown once, cannot be retrieved later, and each works once in place of an authenticator code. Your password is still required at sign-in. Other sessions are signed out when enrollment succeeds.

Codes use 30-second time steps. A successful authenticator code cannot be reused, even for a second security action during the same step; wait for the next code. Ten invalid codes in a 15-minute window temporarily lock verification. The API accepts one neighboring time step in either direction for clock skew.

From **Account security**, use your password and an unused authenticator or recovery code to regenerate recovery codes. This invalidates every old recovery code and signs out other sessions. If the instance policy is optional, you can also disable your own 2FA after the same confirmation. Required enrollment cannot be disabled by an individual user.

## Require enrollment for everyone

An instance admin must enroll their own account first. In **Account security → Instance security**, choose **Require 2FA for everyone** and confirm with the current password and a fresh code.

The policy takes effect immediately on existing sessions and new sign-ins. Users without an authenticator can sign in with their password only to complete enrollment; project APIs and administration remain blocked. They can inspect their session, sign out, and set up 2FA. New invitees follow the same flow after accepting their invitation.

**Make 2FA optional** uses the same confirmation. It lets users choose but does not disable anyone's existing authenticator. Project ingestion keys do not authenticate users and are unaffected by this policy.

## Lost authenticator

Sign in with your password and an unused recovery code. To replace the authenticator when enrollment is optional, disable the old one and enroll again. If enrollment is required, ask the VPS operator to reset your enrollment; changing the instance policy for everyone is unnecessary.

If no recovery code is available, an operator with shell access can deliberately run:

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.yml exec api \
  node dist/cli.mjs admin reset-two-factor user@example.test
```

Use the actual account email. This removes that user's authenticator and recovery codes, revokes all their sessions, and records `auth.two_factor_reset` with a null actor. It does not reset the password or change the instance policy. With enforcement on, the next password sign-in requires fresh enrollment. Ordinary password-reset links never remove 2FA.

If the encryption key is lost, restore it from your secret backup first. If recovery is impossible, configure a new key on every API process and deliberately reset affected accounts through this operator command so they can enroll again. Other accounts remain protected until reset. Do not directly edit the authenticator database state.

## Audit log

Instance admins can open **Account → Audit log** (`/admin/audit-log`). The page shows activity across the instance, newest first, with readable action labels such as "Signed in" and "Project created" in both entries and the action filter. Filtering still uses the API's stable action identifiers; unknown actions fall back to their identifier. Filter by action, actor, and a local date/time range, with an exclusive end time; **Load more** retrieves the next cursor page. Expand **Details** for recorded changes. System and operator actions have no user actor.

2FA setup, enable, disable, verification failures, successful verification, recovery-code use, code regeneration, operator resets, and instance-policy changes are recorded. Entries contain identifiers and action metadata, never authenticator secrets, submitted codes, passwords, or recovery codes. Audit retention remains controlled by `JEKIMO_AUDIT_LOG_DAYS`.

The authentication contract is normative in [access-model.md](access-model.md#two-factor-authentication). The implementation follows [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238.html), including single-use time steps, and the [OWASP multifactor guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) on recovery and reauthentication.
