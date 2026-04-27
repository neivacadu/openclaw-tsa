import { loadConstitution } from "./rules.js";

export type ConstitutionViolation = {
  rule: 4 | 7 | 11 | 14;
  reason: string;
};

export type ToolCallSnapshot = {
  toolName: string;
  params: Record<string, unknown>;
};

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
 * Run all four Constitution checks against a tool call. Returns the first
 * blocking violation, or `null` if the call is allowed.
 *
 * Rule 14 is intentionally non-blocking (gentle warning only) — kept in the
 * function for symmetry with the bash hook but never returned as a violation.
 */
export async function checkConstitution(
  call: ToolCallSnapshot,
): Promise<ConstitutionViolation | null> {
  const payload = serializeParams(call.params);

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
