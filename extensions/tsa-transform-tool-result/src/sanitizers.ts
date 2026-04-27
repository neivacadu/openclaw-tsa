/**
 * Pure sanitizer for tool-result text. No I/O, no async — safe to call from
 * the middleware hot path.
 *
 * Three classes of patterns:
 * 1. Secrets (Anthropic / OpenAI / generic Bearer tokens) -> REDACTED marker
 * 2. Local filesystem identifiers that leak tenant identity (/home/ace-<id>,
 *    /home/tenant-r<n>) -> generic placeholder
 * 3. Top-tier prompt-injection markers -> neutralized so the agent does not
 *    treat tool output as authoritative instructions.
 */
type Pattern = { regex: RegExp; replace: string };

const PATTERNS: Pattern[] = [
  // --- Secrets ------------------------------------------------------------
  // Anthropic OAuth / API keys. sk-ant-* covers oat01 + api03 prefixes.
  { regex: /sk-ant-[a-zA-Z0-9_\-]{20,}/g, replace: "***REDACTED-ANTHROPIC-KEY***" },
  // OpenAI / generic sk-... keys (>=20 alphanumerics, no dash needed).
  { regex: /\bsk-[a-zA-Z0-9]{20,}\b/g, replace: "***REDACTED-API-KEY***" },
  // GitHub PATs.
  { regex: /\bghp_[a-zA-Z0-9]{30,}\b/g, replace: "***REDACTED-GITHUB-PAT***" },
  { regex: /\bgho_[a-zA-Z0-9]{30,}\b/g, replace: "***REDACTED-GITHUB-OAUTH***" },
  // Generic Bearer tokens (HTTP Authorization headers leaking via curl logs).
  { regex: /Bearer\s+[A-Za-z0-9_\-\.]{16,}/g, replace: "Bearer ***REDACTED***" },

  // --- Tenant paths -------------------------------------------------------
  // /home/ace-<id> -> /home/USER. Matches ace-cadu, ace-tsia, ace_tsia, etc.
  { regex: /\/home\/ace[-_][a-z0-9_-]+/gi, replace: "/home/USER" },
  // /home/tenant-r<n> -> /home/TENANT.
  { regex: /\/home\/tenant-r[0-9]+/gi, replace: "/home/TENANT" },

  // --- Injection markers --------------------------------------------------
  // Top-5 jailbreak openers seen in tool output (web pages, file contents,
  // search results). Replace the whole instruction stem with a marker so the
  // agent literally cannot read it as a command.
  {
    regex: /IGNORE\s+(PREVIOUS|PRIOR|ALL|ABOVE)\s+INSTRUCTIONS/gi,
    replace: "[INJECTION-PATTERN-DETECTED]",
  },
  { regex: /SYSTEM\s+OVERRIDE/gi, replace: "[INJECTION-PATTERN-DETECTED]" },
  { regex: /DISREGARD\s+(THE\s+)?(ABOVE|PREVIOUS)/gi, replace: "[INJECTION-PATTERN-DETECTED]" },
  {
    regex: /YOU\s+ARE\s+NOW\s+(IN\s+)?DEVELOPER\s+MODE/gi,
    replace: "[INJECTION-PATTERN-DETECTED]",
  },
  { regex: /\[\s*END\s+OF\s+(USER|HUMAN)\s+TURN\s*\]/gi, replace: "[INJECTION-PATTERN-DETECTED]" },
];

/**
 * Apply all sanitizer patterns in order. Pure: same input -> same output,
 * no exceptions for any string input. If \`text\` is empty, returns "".
 */
export function sanitize(text: string): string {
  let cleaned = text;
  for (const p of PATTERNS) {
    cleaned = cleaned.replace(p.regex, p.replace);
  }
  return cleaned;
}

/** Exposed for unit tests / smoke harness. */
export const __TEST_PATTERNS = PATTERNS;
