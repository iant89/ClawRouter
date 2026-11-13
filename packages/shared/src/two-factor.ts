/**
 * Two-factor sign-in (owner's request). Administrators choose in Settings which
 * methods are allowed and who must use one; users enroll from their account menu.
 */
export const TWO_FACTOR_METHODS = ['totp', 'email'] as const;
/** `totp`: an authenticator app; `email`: a code sent to the user's email address. */
export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

export const TWO_FACTOR_REQUIREMENTS = ['off', 'administrators', 'everyone'] as const;
export type TwoFactorRequirement = (typeof TWO_FACTOR_REQUIREMENTS)[number];

/** GET/PUT /api/settings/sign-in (settings.read / settings.write) */
export interface SignInSecuritySettings {
  /** Methods users may enroll and sign in with. */
  methods: Record<TwoFactorMethod, boolean>;
  /** Who must have two-factor sign-in: they are asked to set it up before anything else. */
  require: TwoFactorRequirement;
  updatedAt: string | null;
}

export type UpdateSignInSecurityRequest = Partial<Pick<SignInSecuritySettings, 'methods' | 'require'>>;

export const MAIL_SECURITY = ['tls', 'starttls', 'none'] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];

/** GET /api/settings/mail (settings.read). The password is never returned. */
export interface MailServerSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null;
  /** Whether a password is stored (it is write-only). */
  passwordSet: boolean;
  /** Sender, e.g. "ClawRouter <clawrouter@example.com>". */
  from: string;
  /** Enabled with a host and a sender: email codes can be sent. */
  configured: boolean;
  updatedAt: string | null;
}

/** PUT /api/settings/mail (settings.write). `password: null` removes it; omit to keep it. */
export interface UpdateMailServerRequest {
  enabled?: boolean;
  host?: string;
  port?: number;
  security?: MailSecurity;
  username?: string | null;
  password?: string | null;
  from?: string;
}

/** GET /api/auth/2fa: the signed-in user's two-factor state. */
export interface TwoFactorStatus {
  /** Methods the administrator allows. */
  allowed: TwoFactorMethod[];
  /** Whether this user must have two-factor sign-in. */
  required: boolean;
  /** Methods this user has set up (and are allowed). */
  enrolled: TwoFactorMethod[];
  email: string | null;
  /** Email codes need a configured mail server. */
  mailConfigured: boolean;
  recoveryCodesLeft: number;
}

/** POST /api/auth/2fa/totp: start setting up an authenticator app. The secret is shown once. */
export interface TotpSetup {
  /** Base32, for typing into the app by hand. */
  secret: string;
  /** otpauth:// URI, for a QR code or a link on the phone. */
  uri: string;
}

/** Returned when a step that creates recovery codes completes. Shown once. */
export interface RecoveryCodes {
  codes: string[];
}

/** POST /api/auth/login when a second step is needed (no session yet). */
export interface SignInChallenge {
  twoFactor: {
    /** Proves the password step; send it with the code. Valid for 10 minutes. */
    challenge: string;
    methods: TwoFactorMethod[];
    /** "a•••@example.com", when email codes are possible. */
    emailHint: string | null;
  };
}

/** POST /api/auth/login/verify */
export interface VerifySignInRequest {
  challenge: string;
  method: TwoFactorMethod | 'recovery';
  code: string;
}

/** Error details when the signed-in user must set up two-factor sign-in first. */
export const TWO_FACTOR_SETUP_REQUIRED = 'two_factor_setup_required';
