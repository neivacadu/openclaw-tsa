/**
 * 20 destructive bash patterns blocked by S1 (TSA Camada 6 · Tier 1).
 *
 * Order/wording mirrors /opt/gold-standard/security-hooks/block-destructive.sh
 * v2.3 (2026-04-27) so the BLOCKED reason text stays grep-compatible with
 * existing dashboards.
 *
 *   - 12 TSA original patterns
 *   - 8 Hermes canonical patterns absorbed in v2.3 (commit eb28145f)
 *
 * Patterns are pure regex — no I/O, evaluated synchronously on the hot path.
 * Compiled once at module load.
 */

export type DestructivePattern = {
  /** Short reason logged + reported back to the agent. */
  reason: string;
  /** Compiled regex matched against the bash command string. */
  regex: RegExp;
};

export const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // === TSA original (12) ===
  { reason: "rm -rf /", regex: /rm\s+-rf\s+\/\s*$/ },
  {
    reason: "rm -rf system path",
    regex: /rm\s+-[rf]+\s+\/(bin|boot|etc|lib|sbin|sys|proc|var|usr)/,
  },
  { reason: "dd to disk device", regex: /dd\s+if=\/dev\/(zero|random|urandom).*of=\/dev\// },
  { reason: "mkfs on device", regex: /mkfs(\.[a-z0-9]+)?\s+\/dev\// },
  { reason: "fork bomb", regex: /:\(\)\s*\{\s*:.*\}.*;.*:/ },
  {
    reason: "credentials.json write/delete",
    regex: /(rm|>|truncate).*\.claude\/\.credentials\.json/,
  },
  { reason: "settings.json write/delete", regex: /(rm|>|truncate).*\.claude\/settings\.json/ },
  { reason: "openclaw.json write/delete", regex: /(rm|>|truncate).*openclaw\.json/ },
  { reason: "/etc/shadow access", regex: /cat\s+\/etc\/(shadow|gshadow|sudoers)/ },
  { reason: "/etc/passwd write", regex: /\/etc\/passwd.*>>/ },
  // SSH key dump — 2-stage: only block when paired with an exfiltration tool.
  // Implemented in code (not regex) below, see SSH_KEY_PATH / SSH_KEY_EXFIL.
  {
    reason: "disabling security",
    regex: /(ufw\s+disable|systemctl\s+stop\s+fail2ban|iptables\s+-F)/,
  },

  // === Hermes canonical hardline (8) ===
  { reason: "rm -rf ~", regex: /rm\s+-rf?\s+~(\s|\/|$)/ },
  { reason: "kill init", regex: /kill\s+-1\s+1(\s|$)/ },
  { reason: "shutdown", regex: /shutdown\s+(-h|-r|now|[0-9])/ },
  {
    reason: "systemctl poweroff/halt/reboot",
    regex: /systemctl\s+(poweroff|halt|reboot|emergency|rescue)(\s|$)/,
  },
  {
    reason: "poweroff/halt/reboot",
    regex: /(^|;|&&|\|\|)\s*(poweroff|halt|reboot)(\s|$)/,
  },
  { reason: "chmod -R /", regex: /chmod\s+-R\s+[0-9]+\s+\/(\s|$)/ },
  { reason: "chown -R /", regex: /chown\s+-R\s+\S+\s+\/(\s|$)/ },
  { reason: "overwrite block device", regex: />\s*\/dev\/sd[a-z][0-9]?(\s|$)/ },
];

// SSH key dump is a 2-stage check: path AND an exfil tool must both appear.
// Kept out of the simple list above so we can guard them as an AND.
const SSH_KEY_PATH = /(\.ssh\/id_(rsa|ed25519|ecdsa)([^.]|$)|authorized_keys)/;
const SSH_KEY_EXFIL = /(cat|less|more|xxd|base64|nc|curl|wget)/;

/**
 * Returns the first matching destructive pattern, or null if the command is
 * allowed. Performs the SSH key 2-stage check after the simple pattern loop.
 *
 * Caller is responsible for honoring the --allow-destructive opt-out before
 * invoking this (matches the bash hook semantics).
 */
export function findDestructiveMatch(command: string): DestructivePattern | null {
  if (!command) return null;
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.regex.test(command)) return p;
  }
  // SSH key dump (2-stage)
  if (SSH_KEY_PATH.test(command) && SSH_KEY_EXFIL.test(command)) {
    return { reason: "SSH key access", regex: SSH_KEY_PATH };
  }
  return null;
}

/** Total count, exported for self-test / smoke. */
export const PATTERN_COUNT = DESTRUCTIVE_PATTERNS.length + 1; // +1 for SSH 2-stage
