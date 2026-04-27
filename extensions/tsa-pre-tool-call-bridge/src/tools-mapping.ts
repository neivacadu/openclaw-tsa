/**
 * Maps an OpenClaw tool name to the bash hook (if any) that should gate it.
 * Returns the absolute path to the hook script, or null when no gating hook
 * applies for that tool. Hooks not listed here are simply skipped.
 *
 * Keep in sync with /home/ace-tsia/.openclaw/hooks/* registrations and the
 * Hermes-style PreToolUse contract (exit 2 = BLOCKED, exit 0 = ALLOWED).
 */

const SECURITY_HOOKS_DIR = "/opt/gold-standard/security-hooks";

const BLOCK_DESTRUCTIVE = `${SECURITY_HOOKS_DIR}/block-destructive.sh`;

/**
 * Tools that go through the block-destructive bash gate. Match is
 * case-insensitive on the tool name.
 */
const BLOCKING_TOOLS = new Set(["bash", "shell", "execute", "exec", "run-shell"]);

export function hookForTool(toolName: string): string | null {
  if (!toolName) return null;
  const lower = toolName.toLowerCase();
  if (BLOCKING_TOOLS.has(lower)) return BLOCK_DESTRUCTIVE;
  return null;
}

/**
 * Tools whose calls we want to mirror to log-edit-intent.sh. These are
 * fire-and-forget — the bash script never blocks (always exits 0) and we
 * don't wait for it. The set covers Edit/Write/MultiEdit and friends.
 */
const EDIT_LIKE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "multi-edit",
  "create",
  "create-file",
  "update-file",
]);

export const LOG_EDIT_INTENT_PATH = `${SECURITY_HOOKS_DIR}/log-edit-intent.sh`;

export function isEditLikeTool(toolName: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return EDIT_LIKE_TOOLS.has(lower);
}
