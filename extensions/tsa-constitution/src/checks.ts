import { loadConstitution } from "./rules.js";

export type ConstitutionViolation = {
  rule: 1 | 4 | 7 | 11 | 14;
  reason: string;
};

export type ToolCallSnapshot = {
  toolName: string;
  params: Record<string, unknown>;
};

// Rule 1 — OAuth-only · NUNCA API key (multi-OAuth + self-host whitelist).
// Allowed OAuth tokens are matched FIRST and short-circuit the API-key scan
// to avoid false positives on `sk-ant-oat01-...` (Claude CLI OAuth) — the
// generic `sk-ant-...` pattern would otherwise match the OAuth prefix.
//
// Multi-provider OAuth permitido (modelo-agnóstico):
//   • Anthropic Claude CLI  — sk-ant-oat01-…
//   • OpenAI Codex CLI      — codex-oauth-token-… (placeholder · ajustar quando tiver token real)
//   • Gemini OAuth (Google) — ya29.…
const ALLOWED_OAUTH_PATTERNS = [
  /sk-ant-oat01-[a-zA-Z0-9_-]+/, // Anthropic OAuth (Claude CLI)
  /codex-oauth-token-[a-zA-Z0-9_-]+/, // OpenAI Codex CLI OAuth (placeholder)
  /ya29\.[a-zA-Z0-9_-]+/, // Gemini / Google OAuth (Bearer)
];

// Self-host endpoints permitidos (Tailscale rede privada · sem auth necessário).
// Quando a chamada é p/ rede privada (100.x.x.x ou loopback) Rule 1 deixa passar
// imediatamente — não é vazamento de credencial p/ provider externo.
const ALLOWED_SELF_HOST_ENDPOINTS = [
  /\bhttp:\/\/100\.\d+\.\d+\.\d+:\d+/, // Tailscale CGNAT (100.64.0.0/10)
  /\bhttp:\/\/127\.0\.0\.1:\d+/, // localhost loopback v4
  /\bhttp:\/\/localhost:\d+/, // localhost name
];

// OAuth file paths permitidos — leitura de credentials de OAuth providers
// é OK (é justamente o que o sistema deve fazer p/ autenticar via CLI).
const ALLOWED_AUTH_FILES = [
  /\.claude\/\.credentials\.json/,
  /\.codex\/auth\.json/,
  /\.config\/gcloud\/application_default_credentials\.json/,
];

const FORBIDDEN_API_KEY_PATTERNS = [
  /sk-ant-api[0-9]{2}-[a-zA-Z0-9_-]{20,}/, // Anthropic genuine API key (sk-ant-apiNN-...)
  /sk-ds-[a-zA-Z0-9]{20,}/, // DeepSeek
  /sk-or-(?:v[0-9]+-)?[a-zA-Z0-9]{20,}/, // OpenRouter (sk-or-v1-... and legacy)
  /sk-proj-[a-zA-Z0-9_-]{20,}/, // OpenAI project keys
  /sk-[a-zA-Z0-9]{40,}/, // OpenAI / generic 48-char key (last to lose ties)
  /AIza[0-9A-Za-z_-]{35}/, // Google / Gemini API key
  /xai-[a-zA-Z0-9]{20,}/, // xAI (Grok)
];

const FORBIDDEN_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
];

const SENSITIVE_PATH_PATTERNS = [
  /\.ssh\/id_/i,
  /\.aws\/credentials/i,
  /\.anthropic/i,
  /API_KEY/,
  /\/etc\/shadow/,
  /\/etc\/passwd/,
  /OPENCLAW_OAUTH_TOKEN/i,
  /sk-ant-oat01/i,
];

const FORBIDDEN_MODEL_PATTERNS = [
  // Rule 7: only the latest Opus is allowed. Block older Opus, all Sonnet/Haiku,
  // and anything from another vendor that an unauthorized caller might inject.
  /\bopus-4-6\b/i,
  /\bsonnet-4-\d/i,
  /\bhaiku-4-\d/i,
  /\bclaude-3/i,
  /\bgpt-/i,
  /\bgemini-/i,
  /\bllama-?[34]/i,
  /\bmistral-/i,
  /\bqwen-/i,
];

const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\brm\s+-rf\s+~/,
  /\bdd\s+if=.+of=\/dev\/[sh]d[a-z]/,
  /\bmkfs\./,
  />\s*\/dev\/[sh]d[a-z]/,
  /\bshred\b/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, // fork bomb
  /\bgit\s+push\s+.*--force\b/,
  /\bDROP\s+DATABASE\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
];

// "--allow-destructive" sentinel — same convention used by block-destructive.sh.
// If callers explicitly opt in we let it through (still logged at warn level).
const DESTRUCTIVE_OVERRIDE = /--allow-destructive\b/;

/**
 * Run all Constitution checks against a tool call. Returns the first
 * blocking violation, or `null` if the call is allowed.
 *
 * Rule 14 is intentionally non-blocking (gentle warning only) — kept in the
 * function for symmetry with the bash hook but never returned as a violation.
 */
export async function checkConstitution(
  call: ToolCallSnapshot,
): Promise<ConstitutionViolation | null> {
  const payload = serializeParams(call.params);

  // Rule 1 — OAuth-only · NUNCA API key. Runs FIRST so genuine API keys are
  // blocked even if they would also match a sensitive-path pattern below.
  const rule1 = checkRule1(call, payload);
  if (rule1) return rule1;

  // Rule 4 — credentials/auth profile: any tool input that exposes a sensitive
  // secret path or OAuth token gets blocked, no matter the tool.
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(payload)) {
      return {
        rule: 4,
        reason: `tool input references sensitive credential path/token (matched ${pattern.source})`,
      };
    }
  }

  // Rule 7 — Opus mais recente: any model coercion to a non-latest model is
  // blocked. The bash hook only inspected the literal "model" key; we match on
  // the serialized payload so it also catches nested invocation arguments.
  for (const pattern of FORBIDDEN_MODEL_PATTERNS) {
    if (pattern.test(payload)) {
      return {
        rule: 7,
        reason: `non-latest model coercion detected (matched ${pattern.source})`,
      };
    }
  }

  // Rule 11 — destructive prod operations on bash-style tools.
  if (isBashLikeTool(call.toolName)) {
    const command = extractCommandString(call.params);
    if (command && !DESTRUCTIVE_OVERRIDE.test(command)) {
      for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
        if (pattern.test(command)) {
          return {
            rule: 11,
            reason: `destructive command without --allow-destructive (matched ${pattern.source})`,
          };
        }
      }
    }
  }

  // Rule 14 — pt-BR translation hint: read the constitution if available so
  // we keep a single source of truth, but never block. (Future work: surface
  // a warning back to the agent via a logger or status channel.)
  void loadConstitution();

  return null;
}

/**
 * Rule 1 — OAuth-only · NUNCA API key (multi-OAuth + self-host whitelist).
 *
 * Modelo-agnóstico: aceita OAuth de múltiplos providers (Claude CLI, Codex CLI,
 * Gemini) e também whitelista endpoints self-host na rede privada Tailscale
 * (100.x) e localhost. Bloqueia API keys diretas de qualquer provider.
 *
 * Order of checks:
 *   1. Self-host endpoint match (Tailscale / localhost)         → PASS
 *   2. OAuth credential file path match                         → PASS
 *   3. Forbidden env var name match                             → BLOCK
 *   4. Forbidden API-key shape match (after stripping OAuth)    → BLOCK
 *
 * Exported for in-process smoke tests. Pass the pre-serialized payload when
 * available to avoid double-stringifying.
 */
export function checkRule1(call: ToolCallSnapshot, payload?: string): ConstitutionViolation | null {
  const params = call.params ?? {};
  const env = (params as { env?: Record<string, unknown> }).env ?? {};
  const command = extractCommandString(params) ?? "";
  const url =
    typeof (params as { url?: unknown }).url === "string" ? (params as { url: string }).url : "";
  const inputStr = payload ?? serializeParams(params);

  // 1 — Self-host endpoints (Tailscale rede privada / localhost): rede privada,
  // sem provider externo envolvido, então não há vazamento de credencial.
  for (const pattern of ALLOWED_SELF_HOST_ENDPOINTS) {
    if (pattern.test(url) || pattern.test(command) || pattern.test(inputStr)) {
      return null; // self-host OK
    }
  }

  // 2 — OAuth credential file paths permitidos (Claude CLI, Codex CLI, gcloud).
  // Ler estes arquivos é justamente o mecanismo de autenticação OAuth.
  for (const pattern of ALLOWED_AUTH_FILES) {
    if (pattern.test(command) || pattern.test(inputStr)) {
      return null; // OAuth file access OK
    }
  }

  // 3 — env var name allow/deny: cheap exact-match scan first.
  for (const envVar of FORBIDDEN_ENV_VARS) {
    if (Object.prototype.hasOwnProperty.call(env, envVar)) {
      return {
        rule: 1,
        reason: `env var ${envVar} detected. Use OAuth (Claude CLI · Codex CLI · Gemini) instead.`,
      };
    }
    // Also catch `export FOO=...` / `FOO=... cmd` baked into the bash command.
    if (command && new RegExp(`\\b${envVar}\\s*=`).test(command)) {
      return {
        rule: 1,
        reason: `env var ${envVar} set inline in command. Use OAuth (Claude CLI · Codex CLI · Gemini) instead.`,
      };
    }
  }

  // 4 — token shape match. Strip allowed OAuth substrings before scanning so
  // OAuth tokens (sk-ant-oat01-… · ya29.… · codex-oauth-token-…) cannot be
  // mistaken for generic API keys.
  let scanStr = inputStr;
  for (const pattern of ALLOWED_OAUTH_PATTERNS) {
    scanStr = scanStr.replace(new RegExp(pattern.source, "g"), "[oauth]");
  }

  for (const pattern of FORBIDDEN_API_KEY_PATTERNS) {
    if (pattern.test(scanStr)) {
      return {
        rule: 1,
        reason: `API key detected (matched ${pattern.source}). Use OAuth (Claude CLI · Codex CLI · Gemini) instead.`,
      };
    }
  }

  return null;
}

function isBashLikeTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return lower === "bash" || lower.includes("shell") || lower.includes("exec");
}

function extractCommandString(params: Record<string, unknown>): string | null {
  const candidates = ["command", "cmd", "script", "input"];
  for (const key of candidates) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Cheap JSON serialization used to grep tool params for sensitive substrings.
 * Falls back to String() if the params have circular refs (very unlikely here).
 */
function serializeParams(params: Record<string, unknown>): string {
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}
