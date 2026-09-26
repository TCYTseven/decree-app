import { maskSecrets, REDACTED } from "../core/mask-secrets.js";

/**
 * Token shapes the core masker (src/core/mask-secrets.ts) does not know yet: Stripe live/test keys, Google API
 * keys, JWTs, GitLab / npm / SendGrid / Hugging Face tokens. They are recognizable on their own, so they are
 * masked wherever they appear, including as a fallback literal (`process.env.X ?? 'sk_live_…'`).
 */
const EXTRA_TOKEN_SRC =
  "[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}|hf_[A-Za-z0-9]{30,}";
/** The core masker's shapes (kept in sync by hand) plus the extra ones: used to judge a single value. */
const ALL_TOKEN_SRC =
  "sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|" +
  EXTRA_TOKEN_SRC;
const EXTRA_TOKEN_RE = new RegExp(`\\b(?:${EXTRA_TOKEN_SRC})\\b`, "g");
const ANY_TOKEN_RE = new RegExp(`(?:^|\\b)(?:${ALL_TOKEN_SRC})`);

/** Core masking plus the extra token shapes. */
export function maskScannedText(text: string): string {
  return maskSecrets(text).replace(EXTRA_TOKEN_RE, REDACTED);
}

/** True when a value contains a known credential shape, whatever the variable is called. */
export function looksLikeToken(value: string): boolean {
  return ANY_TOKEN_RE.test(value);
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[a-z0-9_-]+)$/i;

/**
 * `scheme://user:password@host/...`: the password is masked unless the host is local / a compose service name
 * (`postgres://postgres:postgres@localhost:5432/app` is a documented default, not a secret).
 */
export function maskUrlCredentials(value: string): string {
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/'"`]*):([^\s@/'"`]+)@([^\s/:'"`?#]+)/gi, (m, scheme: string, user: string, _pw: string, host: string) =>
    LOCAL_HOST_RE.test(host) ? m : `${scheme}${user}:${REDACTED}@${host}`,
  );
}
