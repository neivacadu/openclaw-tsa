/**
 * Pure binding resolver. Given the configured `skill_bindings` list for a
 * provider (telegram, discord, slack, ...) and the incoming channel id (and
 * optional parent id, e.g. discord guild id when the message id is a channel
 * inside that guild), return the deduplicated list of skills to preload.
 *
 * Match precedence (mirrors Hermes 8fb861ea):
 *   1. Exact id match on `channelId`
 *   2. Exact id match on `parentId` (if provided)
 *   3. Entry with `id === "default"`
 *   4. Empty list
 *
 * The function is intentionally synchronous and side-effect free so the
 * plugin can call it on every inbound message without IO cost.
 */

export type SkillBinding = {
  id: string;
  /** Preferred field: explicit list of skill ids. */
  skills?: string[];
  /** Compatibility shorthand: a single skill id. */
  skill?: string;
};

export function resolveSkills(
  bindings: ReadonlyArray<SkillBinding> | undefined | null,
  channelId: string | undefined | null,
  parentId?: string | null,
): string[] {
  if (!bindings || bindings.length === 0) return [];
  const list = bindings.filter((b) => b && typeof b.id === "string");

  if (channelId) {
    const exact = list.find((b) => b.id === channelId);
    if (exact) return normalizeSkills(exact);
  }
  if (parentId) {
    const parent = list.find((b) => b.id === parentId);
    if (parent) return normalizeSkills(parent);
  }
  const dflt = list.find((b) => b.id === "default");
  if (dflt) return normalizeSkills(dflt);
  return [];
}

function normalizeSkills(b: SkillBinding): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (Array.isArray(b.skills)) {
    for (const raw of b.skills) {
      if (typeof raw !== "string") continue;
      const s = raw.trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  if (typeof b.skill === "string") {
    const s = b.skill.trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Pull the `skill_bindings` array for a given provider out of an OpenClaw
 * config object. Returns `[]` when the channel section is missing or
 * malformed — never throws, so the caller can stay on the hot path.
 *
 * Accepts both `skill_bindings` (canonical) and `skillBindings` (camelCase
 * alias) for ergonomics in code that constructs config programmatically.
 */
export function readBindingsFromConfig(
  config: Record<string, unknown> | undefined | null,
  provider: string,
): SkillBinding[] {
  if (!config || typeof config !== "object") return [];
  const channels = (config as { channels?: Record<string, unknown> }).channels;
  if (!channels || typeof channels !== "object") return [];
  const section = (channels as Record<string, unknown>)[provider];
  if (!section || typeof section !== "object") return [];

  const candidate =
    (section as { skill_bindings?: unknown }).skill_bindings ??
    (section as { skillBindings?: unknown }).skillBindings;

  if (!Array.isArray(candidate)) return [];

  return candidate.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) return [];
    const out: SkillBinding = { id };
    const skills = (entry as { skills?: unknown }).skills;
    if (Array.isArray(skills)) {
      out.skills = skills.filter((s): s is string => typeof s === "string");
    }
    const skill = (entry as { skill?: unknown }).skill;
    if (typeof skill === "string") {
      out.skill = skill;
    }
    return [out];
  });
}
