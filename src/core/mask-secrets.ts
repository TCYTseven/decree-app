/**
 * Mask hardcoded secrets in source/docs excerpts before they are sent to the
 * planner LLM or written to `.decree/profile.json`. Heuristic and conservative:
 * references (process.env.X, os.getenv(...), ${VAR}, settings.X) are kept so the
 * planner still sees which env vars a project reads; literal values are replaced
 * with `[REDACTED]`.
 */

export const REDACTED = "[REDACTED]";

const SECRET_WORDS = new Set([
  "key", "keys", "apikey", "accesskey", "secretkey", "privatekey",
  "token", "tokens", "secret", "secrets", "password", "passwords", "passwd",
  "private", "credential", "credentials",
]);

/** True for names like API_KEY, apiKey, "client-secret", db.password, AUTH_TOKEN, privateKey. */
export function isSecretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some(
    (w) => SECRET_WORDS.has(w) || /(token|secret|password|passwd|credentials?)$/.test(w) || /^(api|access|secret|private)key$/.test(w),
  );
}

/** A value that points somewhere else (env lookups, templates, attribute paths) rather than holding a secret. */
function isReference(value: string): boolean {
  if (/^(\$|\{|<|%|\[|\*)/.test(value)) return true;
  if (/^(true|false|null|none|nil|undefined|yes|no|on|off)$/i.test(value)) return true;
  if (/^\d{1,7}$/.test(value)) return true;
  if (/\(/.test(value)) return true; // a call: os.getenv("X"), config.get(...)
  if (/^(process|os|env|import|settings|config|self|this|ENV)\b/.test(value)) return true;
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value); // attribute path: settings.API_KEY
}

const PEM_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
// scheme://user:password@host -> scheme://user:[REDACTED]@host
const URL_CRED_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/'"`]*):([^\s@/'"`]+)@/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/g;
// Well-known token shapes (Anthropic/OpenAI-style sk-, GitHub, AWS access key ids, Slack).
const TOKEN_SHAPES_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g;
// NAME [: type] (=|:|:=|=>) value, on one line; NAME may be quoted (JSON / YAML / dict keys).
const ASSIGN_RE =
  /(?<![\w.-])(["']?)([A-Za-z_][\w.-]*)\1([ \t]*(?::[ \t]*[A-Za-z_][\w.<>[\]|]*[ \t]*)?(?:=>|:=|=|:)[ \t]*)(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`|([^\s,;'"`)}\]]+))/g;

/** Replace hardcoded secrets in `text` with `[REDACTED]`. */
export function maskSecrets(text: string): string {
  return text
    .replace(PEM_RE, REDACTED)
    .replace(URL_CRED_RE, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`)
    .replace(BEARER_RE, (_m, kind: string) => `${kind} ${REDACTED}`)
    .replace(TOKEN_SHAPES_RE, REDACTED)
    .replace(ASSIGN_RE, (m, q: string, name: string, sep: string, dq?: string, sq?: string, bq?: string, bare?: string) => {
      if (!isSecretName(name)) return m;
      const lhs = `${q}${name}${q}${sep}`;
      const quoted = dq ?? sq ?? bq;
      if (quoted !== undefined) {
        const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "`";
        // Empty strings, templates/references and prose (descriptions contain spaces) are kept.
        if (quoted === "" || quoted === REDACTED || /\s/.test(quoted) || isReference(quoted)) return m;
        return `${lhs}${quote}${REDACTED}${quote}`;
      }
      if (bare === undefined || isReference(bare)) return m;
      return `${lhs}${REDACTED}`;
    });
}
