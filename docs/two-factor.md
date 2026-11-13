# Two-factor sign-in

The owner's answer (2026-11-13): two-factor sign-in "should be configured in
settings by administrator". Administrators choose **which methods** are allowed
and **who must use one**; users set up their own methods.

## Administrator settings (Administration → Settings)

| Setting | Values | Stored as |
|---|---|---|
| Allowed methods | Authenticator app (TOTP), Codes by email | `security.sign_in` |
| Who must use it | Optional · Required for administrators · Required for everyone | `security.sign_in` |
| Mail server | host, port, encryption (STARTTLS / TLS / none), username, password, sender | `mail.server` |

- Defaults: authenticator app allowed, email codes not allowed, optional.
- Requiring two-factor sign-in needs at least one allowed method, and email codes
  need a mail server: the server refuses a policy nobody could satisfy.
- "Administrators" means users holding the built-in **Administrator** role.
- The mail password is **write-only**: encrypted with the secret key (context
  `settings:mail.server:password`), never returned, audited only as
  `signInDetailsChanged: true`. *Send a test message to me* sends to the
  administrator's own address.
- Changes need `settings.write`, are audited (`SETTINGS_CHANGED`) and apply
  without a restart.

## Methods

| Method | How it works |
|---|---|
| **Authenticator app** | RFC 6238 TOTP: SHA-1, 6 digits, 30 seconds, ±1 step of clock drift. The secret is shown once (as text and an `otpauth://` link; no QR code), stored encrypted, and confirmed with a first code. A code cannot be used twice (`totp_last_step`). |
| **Email codes** | A 6-digit code sent to the user's email address, valid 10 minutes. Turning it on sends a code to confirm the address. A new address (changed by the user, or by an administrator) turns email codes off until confirmed again. |
| **Recovery codes** | 10 one-time codes (`xxxx-xxxx`), shown once when the first method is turned on, stored hashed. New codes (with the password) replace the old ones. |

## Signing in

1. `POST /api/auth/login` with the password. Users without two-factor sign-in get
   a session as before. Users with it get a **challenge** instead:
   `{ twoFactor: { challenge, methods, emailHint } }`. No session exists yet.
2. For email: `POST /api/auth/login/email-code` sends a code (again after 30 s).
3. `POST /api/auth/login/verify` with `{ challenge, method, code }`, where method
   is `totp`, `email` or `recovery`. On success the session is created.

Challenges last **10 minutes** and allow **5 wrong codes**; then the password is
needed again. Tokens and codes are stored hashed. Each wrong code is audited as
`LOGIN_FAILED` (reason `second_factor`); the password step stays throttled as before.

## Required but not set up

When the policy requires two-factor sign-in and the user has no usable method,
the session reports `twoFactorSetupRequired: true` and every API call except the
session, password change, sign-out, `/api/auth/2fa*` and `PUT /api/auth/email`
answers **403 `two_factor_setup_required`**. The live channel refuses the
connection. The console shows only the setup screen until a method is on, and
keeps showing the new recovery codes until the user confirms they saved them.

## Users

- **User menu → Sign-in security**: email address (changed with the password),
  authenticator app, email codes, recovery codes. Removing a method needs the password.
- **Administration → Users**: an email address on create and edit, each user's
  methods in the Status column, and **Reset two-factor sign-in** (lost phone),
  under the same no-escalation rule as other user changes (`users.write`). Your
  own address can only be changed under Sign-in security, with your password.
- **Command line**: `bun run reset-password <user> --reset-2fa` also removes the
  user's two-factor sign-in.

Audit actions: `TWO_FACTOR_ENABLED`, `TWO_FACTOR_DISABLED`, `TWO_FACTOR_RESET`,
`RECOVERY_CODES_GENERATED`, `EMAIL_CHANGED`.

## Code

- `packages/authentication/src/totp.ts`, `two-factor.ts`, `sqlite/two-factor.ts`
- `packages/mail/` (SMTP client, mail settings service); `tests/support/mock-smtp.ts`
- `packages/api/src/controllers/two-factor.ts`; migration `0016_two_factor.ts`
- Console: `features/auth/SecondStep.tsx`, `AccountSecurity.tsx`,
  `ForcedTwoFactorSetup.tsx`, `features/settings/SignInSecuritySettings.tsx`
- Tests: `packages/api/test/two-factor-api.test.ts`,
  `packages/authentication/test/totp.test.ts` (RFC vectors),
  `packages/mail/test/smtp.test.ts`

## Limitations

- No QR code: the setup key is shown as text with an `otpauth://` link.
- The SMTP client was tested against a local mock server without encryption.
  The TLS and STARTTLS paths have not been tried against a real mail server.
- No passkeys or WebAuthn.
