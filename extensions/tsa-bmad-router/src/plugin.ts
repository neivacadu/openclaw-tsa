/**
 * tsa-bmad-router plugin core (Pick P1-C, Ace-TSIA v3.1) — SDK refactor.
 *
 * Hook: `subagent_spawning`. When Camada 1 dispara um spawn pra
 * `targetAgent` (default `0-joker`), classifica complexidade da request
 * (heurística zero-LLM) e, em score >= threshold, injeta um persona-flag
 * BMAD no `systemPromptPrepend` do spawn args, mais metadata pra phase-hint
 * em cascadas seguintes.
 *
 * Default ship: `enabled:false` no openclaw.json + `monitorOnly:true` —
 * primeira semana só observa, decisão é shadow_*.
 *
 * Ordering:
 *   - BEFORE `tsa-multi-persona-prompt` (este escolhe a persona; aquele
 *     aplica overlay no prompt build).
 *
 * Compat: zero-LLM no caminho quente. Falha-aberta: qualquer erro -> vanilla.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Complexity = 1 | 2 | 3;

/**
 * BMAD canonical phases (v6 numbered slugs). Ordered.
 *   1-analysis        — Mary etc. levantam problema/contexto.
 *   2-plan-workflows  — James/Sophia desenham o plano e os workflows.
 *   3-solutioning     — Winston traduz pra arquitetura/solução técnica.
 *   4-implementation  — Carlos/Diana constroem; Liam/Olivia validam.
 */
export type BmadPhase = "1-analysis" | "2-plan-workflows" | "3-solutioning" | "4-implementation";

export interface PersonaRegistryEntry {
  /** Slug as used in personaMapping config — e.g. "mary-analyst". */
  slug: string;
  /** Absolute path to the persona MD file. */
  path: string;
  /** Phase this persona belongs to. */
  phase: BmadPhase;
}

export interface RouterConfig {
  complexityThreshold: 1 | 2 | 3;
  bmadPersonasDir: string;
  phaseSequence: BmadPhase[];
  personaMapping: Record<BmadPhase, string[]>;
  fallbackToVanillaJoker: boolean;
  logDecisions: boolean;
  monitorOnly: boolean;
  targetAgent: string;
  longRequestThreshold: number;
  complexKeywords: string[];
  stakeholderKeywords: string[];
  multiStepRegex: string;
}

export const DEFAULT_CONFIG: RouterConfig = {
  complexityThreshold: 3,
  bmadPersonasDir: "/home/ace-tsia/.openclaw/workspace/_bmad/core/agents",
  phaseSequence: ["1-analysis", "2-plan-workflows", "3-solutioning", "4-implementation"],
  personaMapping: {
    "1-analysis": ["mary-analyst", "james-strategist"],
    "2-plan-workflows": ["sophia-designer", "james-strategist"],
    "3-solutioning": ["winston-architect", "sophia-designer"],
    "4-implementation": ["carlos-impl", "diana-builder", "liam-reviewer", "olivia-qa"],
  },
  fallbackToVanillaJoker: true,
  logDecisions: true,
  monitorOnly: true,
  targetAgent: "0-joker",
  longRequestThreshold: 200,
  complexKeywords: [
    "estrategia",
    "estratégia",
    "redesign",
    "redesenhe",
    "arquitetura",
    "analise profunda",
    "análise profunda",
    "plano completo",
    "estrutura",
    "estruture",
    "monte",
    "construa",
    "desenhe",
    "roadmap",
    "framework",
  ],
  stakeholderKeywords: [
    "para a equipe",
    "para clientes",
    "diretoria",
    "stakeholders",
    "investidores",
    "board",
  ],
  multiStepRegex: "(primeiro|first).{0,40}(depois|then|second).{0,40}(ent[aã]o|finally|third)",
};

/** Spawn args passed by the harness on `subagent_spawning`. Free-form by
 *  design — we mutate `systemPromptPrepend` and `metadata.bmad`. */
export interface JokerSpawnArgs {
  /** Slug of the agent being spawned (e.g. "0-joker", "0-hero"). */
  agent: string;
  /** Original user request for this turn. */
  request: string;
  /** Optional system prompt prepend string the harness will concatenate. */
  systemPromptPrepend?: string;
  /** Optional metadata bag — we stamp our decision here. */
  metadata?: Record<string, unknown>;
  /** Anything else the harness passes through. We pass-through unchanged. */
  [k: string]: unknown;
}

export interface RouteDecision {
  /** Original target agent. */
  target: string;
  /** Computed complexity 1/2/3. */
  complexity: Complexity;
  /** Heuristic signals that contributed to the score (for logs). */
  signals: {
    longRequest: boolean;
    keywordHits: string[];
    multiStep: boolean;
    stakeholders: boolean;
  };
  /** Phase chosen on this cascade. */
  phase: BmadPhase | null;
  /** Persona chosen (slug + path), or null when vanilla. */
  persona: PersonaRegistryEntry | null;
  /** Effect actually applied to spawn args. */
  applied: "vanilla_joker" | "persona_injected" | "shadow_persona_injected_monitor_only";
  /** Free-form reason for audit logs. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Heuristic complexity classifier
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFC");
}

export function classifyComplexity(
  request: string,
  cfg: RouterConfig = DEFAULT_CONFIG,
): { complexity: Complexity; signals: RouteDecision["signals"] } {
  const text = normalize(request ?? "");
  const longRequest = (request ?? "").length > cfg.longRequestThreshold;

  const keywordHits: string[] = [];
  for (const kw of cfg.complexKeywords) {
    if (text.includes(normalize(kw))) keywordHits.push(kw);
  }

  const stakeholders = cfg.stakeholderKeywords.some((kw) => text.includes(normalize(kw)));

  let multiStep = false;
  try {
    const re = new RegExp(cfg.multiStepRegex, "i");
    multiStep = re.test(text);
  } catch {
    multiStep = false;
  }

  const signals = { longRequest, keywordHits, multiStep, stakeholders };

  // Score:
  //   keyword hit -> +2 (likely architecture/strategy/etc.)
  //   stakeholders -> +1
  //   multiStep -> +1
  //   longRequest -> +1
  // Bands: >=3 -> 3; >=1 -> 2; else 1.
  let score = 0;
  if (keywordHits.length > 0) score += 2;
  if (stakeholders) score += 1;
  if (multiStep) score += 1;
  if (longRequest) score += 1;

  let complexity: Complexity;
  if (score >= 3) complexity = 3;
  else if (score >= 1) complexity = 2;
  else complexity = 1;

  return { complexity, signals };
}

// ---------------------------------------------------------------------------
// Persona registry
// ---------------------------------------------------------------------------

export interface PersonaResolver {
  /** Returns full persona entry, or null if not resolvable. */
  resolve(slug: string, phase: BmadPhase): PersonaRegistryEntry | null;
  /** True when the registry has a usable persona file for the slug. */
  exists(slug: string): boolean;
}

export class FsPersonaResolver implements PersonaResolver {
  private cache = new Map<string, boolean>();

  constructor(
    private baseDir: string,
    /** Injected for testability — defaults to `node:fs.existsSync`. */
    private existsSync: (p: string) => boolean = (p) => {
      // Lazy import keeps test bundles fs-free when caller injects.
      // Using createRequire because plugin runs as ESM (type:module) in fork.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createRequire } = require("node:module") as typeof import("node:module");
      const req = createRequire(import.meta.url);
      const fs = req("node:fs") as typeof import("node:fs");
      return fs.existsSync(p);
    },
  ) {}

  private pathFor(slug: string): string {
    return `${this.baseDir}/${slug}.md`;
  }

  exists(slug: string): boolean {
    if (this.cache.has(slug)) return this.cache.get(slug)!;
    const present = this.existsSync(this.pathFor(slug));
    this.cache.set(slug, present);
    return present;
  }

  resolve(slug: string, phase: BmadPhase): PersonaRegistryEntry | null {
    if (!this.exists(slug)) return null;
    return { slug, path: this.pathFor(slug), phase };
  }
}

/** In-memory resolver — used in tests and as fallback when fs is unavailable. */
export class InMemoryPersonaResolver implements PersonaResolver {
  constructor(
    private known: Set<string>,
    private baseDir: string,
  ) {}

  exists(slug: string): boolean {
    return this.known.has(slug);
  }

  resolve(slug: string, phase: BmadPhase): PersonaRegistryEntry | null {
    if (!this.known.has(slug)) return null;
    return { slug, path: `${this.baseDir}/${slug}.md`, phase };
  }
}

// ---------------------------------------------------------------------------
// BmadRouter — picks persona + injects flag
// ---------------------------------------------------------------------------

export class BmadRouter {
  constructor(
    private cfg: RouterConfig,
    private resolver: PersonaResolver,
    /** Injected logger — defaults to console.log. */
    private logger: (msg: string, payload?: unknown) => void = (m, p) => {
      // eslint-disable-next-line no-console
      if (p !== undefined) console.log(m, JSON.stringify(p));
      // eslint-disable-next-line no-console
      else console.log(m);
    },
  ) {}

  /** Picks persona for a phase. Walks the configured candidate list and
   *  returns the first whose file exists. Falls back through phaseSequence
   *  if no candidate of the requested phase resolves. */
  pickPersona(phase: BmadPhase): PersonaRegistryEntry | null {
    const candidates = this.cfg.personaMapping[phase] ?? [];
    for (const slug of candidates) {
      const entry = this.resolver.resolve(slug, phase);
      if (entry) return entry;
    }
    // Phase candidates all missing — try other phases in order so we still
    // ship a persona rather than degrading to vanilla.
    for (const fallbackPhase of this.cfg.phaseSequence) {
      if (fallbackPhase === phase) continue;
      const fb = this.cfg.personaMapping[fallbackPhase] ?? [];
      for (const slug of fb) {
        const entry = this.resolver.resolve(slug, fallbackPhase);
        if (entry) return entry;
      }
    }
    return null;
  }

  /** Infers the BMAD phase from the request text. `1-analysis` is the
   *  default first phase. Keywords pull straight to the matching phase:
   *    arquitetura/redesign/design/estrutura -> 3-solutioning
   *    plano/roadmap/workflow                -> 2-plan-workflows
   *    implemente/deploy/build/construa      -> 4-implementation
   *    review/valide/qa/auditoria/verifique  -> 4-implementation (review sub)
   */
  pickPhase(request: string, hintedPhase: BmadPhase | null): BmadPhase {
    if (hintedPhase) return hintedPhase;
    const t = normalize(request ?? "");
    if (/\b(arquitetura|redesign|redesenhe|design|estrutura|estruture)\b/.test(t)) {
      return "3-solutioning";
    }
    if (/\b(plano|roadmap|workflow|workflows|planejamento)\b/.test(t)) {
      return "2-plan-workflows";
    }
    if (/\b(implemente|deploy|build|construa|execute)\b/.test(t)) {
      return "4-implementation";
    }
    if (/\b(review|valide|qa|auditoria|verifique)\b/.test(t)) {
      return "4-implementation";
    }
    return "1-analysis";
  }

  /** Builds the system-prompt prepend string that loads the persona MD. */
  buildPrependFor(persona: PersonaRegistryEntry): string {
    return [
      "# BMAD persona-flag (auto-injected by tsa-bmad-router)",
      `Você está operando como **${persona.slug}** (fase: ${persona.phase}).`,
      `Carregue o arquivo de persona: ${persona.path}`,
      "Aplique-o como overlay sobre o prompt base do JOKER.",
      "Ao concluir a fase, sugira a próxima persona/fase no rodapé da sua resposta.",
      "",
    ].join("\n");
  }

  /** Mutates `args` in-place when persona is to be injected (and not in
   *  monitorOnly). Always returns the decision for audit logs. */
  injectPersonaFlag(args: JokerSpawnArgs, persona: PersonaRegistryEntry): void {
    const prepend = this.buildPrependFor(persona);
    args.systemPromptPrepend =
      (args.systemPromptPrepend ? args.systemPromptPrepend + "\n\n" : "") + prepend;
    args.metadata = {
      ...(args.metadata ?? {}),
      bmad: {
        persona: persona.slug,
        phase: persona.phase,
        injectedBy: "tsa-bmad-router",
        injectedAt: new Date().toISOString(),
      },
    };
  }

  /** Main hook. Idempotent — same input always produces the same decision. */
  routeJokerSpawn(args: JokerSpawnArgs): RouteDecision {
    // 1. Bypass for non-target agents — pass through untouched.
    if (args.agent !== this.cfg.targetAgent) {
      return {
        target: args.agent,
        complexity: 1,
        signals: {
          longRequest: false,
          keywordHits: [],
          multiStep: false,
          stakeholders: false,
        },
        phase: null,
        persona: null,
        applied: "vanilla_joker",
        reason: `target=${args.agent} != ${this.cfg.targetAgent} — bypass`,
      };
    }

    // 2. Classify complexity.
    const { complexity, signals } = classifyComplexity(args.request, this.cfg);

    // 2b. Phase-hint escalation: if a previous cascade stamped
    //     metadata.bmad.nextPhase, we are mid-BMAD and must continue —
    //     even if the follow-up request looks short/simple.
    const hintedPhase = readPhaseHint(args);

    // 3. Below threshold AND no hint -> vanilla JOKER.
    if (complexity < this.cfg.complexityThreshold && !hintedPhase) {
      const decision: RouteDecision = {
        target: args.agent,
        complexity,
        signals,
        phase: null,
        persona: null,
        applied: "vanilla_joker",
        reason: `complexity=${complexity} < threshold=${this.cfg.complexityThreshold}`,
      };
      if (this.cfg.logDecisions) {
        this.logger("[tsa-bmad-router] vanilla", decision);
      }
      return decision;
    }

    // 4. Pick phase + persona (hintedPhase already read above).
    const phase = this.pickPhase(args.request, hintedPhase);
    const persona = this.pickPersona(phase);

    // 5. No persona resolvable -> fallback (or shadow if fallback disabled).
    if (!persona) {
      const decision: RouteDecision = {
        target: args.agent,
        complexity,
        signals,
        phase,
        persona: null,
        applied: "vanilla_joker",
        reason: `no persona file resolvable in ${this.cfg.bmadPersonasDir} for phase=${phase}`,
      };
      if (this.cfg.logDecisions) {
        this.logger("[tsa-bmad-router] no-persona-fallback", decision);
      }
      return decision;
    }

    // 6. Apply (or shadow-apply in monitorOnly).
    if (this.cfg.monitorOnly) {
      const decision: RouteDecision = {
        target: args.agent,
        complexity,
        signals,
        phase,
        persona,
        applied: "shadow_persona_injected_monitor_only",
        reason: `would inject persona=${persona.slug} (monitorOnly)`,
      };
      if (this.cfg.logDecisions) {
        this.logger("[tsa-bmad-router] SHADOW", decision);
      }
      return decision;
    }

    this.injectPersonaFlag(args, persona);
    const decision: RouteDecision = {
      target: args.agent,
      complexity,
      signals,
      phase,
      persona,
      applied: "persona_injected",
      reason: `injected persona=${persona.slug} for phase=${phase}`,
    };
    if (this.cfg.logDecisions) {
      this.logger("[tsa-bmad-router] inject", decision);
    }
    return decision;
  }
}

/** Reads a phase hint from spawn metadata (set by previous cascade). */
function readPhaseHint(args: JokerSpawnArgs): BmadPhase | null {
  const meta = args.metadata as Record<string, unknown> | undefined;
  const bmad = meta?.bmad as { nextPhase?: string } | undefined;
  const next = bmad?.nextPhase;
  if (
    next === "1-analysis" ||
    next === "2-plan-workflows" ||
    next === "3-solutioning" ||
    next === "4-implementation"
  ) {
    return next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory — same surface used by smoke tests and SDK register().
// ---------------------------------------------------------------------------

export interface FactoryDeps {
  resolver?: PersonaResolver;
  logger?: (msg: string, payload?: unknown) => void;
}

export function createBmadRouter(
  cfg: Partial<RouterConfig> = {},
  deps: FactoryDeps = {},
): BmadRouter {
  const merged: RouterConfig = mergeConfig(DEFAULT_CONFIG, cfg);
  const resolver = deps.resolver ?? new FsPersonaResolver(merged.bmadPersonasDir);
  return new BmadRouter(merged, resolver, deps.logger);
}

/** Shallow-merge config but deep-merge personaMapping when present, so a
 *  partial override of one phase doesn't wipe defaults for the others. */
function mergeConfig(base: RouterConfig, override: Partial<RouterConfig>): RouterConfig {
  const merged: RouterConfig = { ...base, ...override };
  if (override.personaMapping) {
    merged.personaMapping = {
      ...base.personaMapping,
      ...override.personaMapping,
    } as Record<BmadPhase, string[]>;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// SDK register — wires `subagent_spawning` hook with target=0-joker filter.
// ---------------------------------------------------------------------------

/**
 * Hook event shape (best-effort — harness contract per tsa-cascade-monitor).
 * - `agentId`   — slug of the spawning subagent (filter on targetAgent here).
 * - `args`      — spawn args bag we mutate (`systemPromptPrepend`, metadata).
 * - `request`   — raw user request when available (fallback to ctx).
 */
interface SubagentSpawningEvent {
  agentId?: string;
  args?: JokerSpawnArgs;
  request?: string;
  childSessionKey?: string;
}

interface SubagentSpawningCtx {
  requesterSessionKey?: string;
  request?: string;
  [k: string]: unknown;
}

/** Plugin entry-point, called by `definePluginEntry({ register })`. */
export function registerBmadRouter(api: OpenClawPluginApi): void {
  // Build router lazily on first event so config from openclaw.json is
  // already attached to api.config by the harness.
  let router: BmadRouter | null = null;
  const rawCfg = (api.config ?? {}) as Partial<RouterConfig>;

  function getRouter(): BmadRouter {
    if (router) return router;
    router = createBmadRouter(rawCfg, {
      logger: (msg, payload) => {
        try {
          if (payload !== undefined) {
            api.logger.info(`${msg} ${JSON.stringify(payload)}`);
          } else {
            api.logger.info(msg);
          }
        } catch {
          /* never let a log throw block the spawn */
        }
      },
    });
    return router;
  }

  // Effective targetAgent for the early filter — read once from config so we
  // skip non-JOKER spawns without spinning up the router.
  const targetAgent =
    typeof rawCfg.targetAgent === "string" && rawCfg.targetAgent.length > 0
      ? rawCfg.targetAgent
      : DEFAULT_CONFIG.targetAgent;

  api.on<SubagentSpawningEvent, SubagentSpawningCtx, void>("subagent_spawning", (event, ctx) => {
    try {
      const agentId = event?.agentId ?? event?.args?.agent ?? "";
      if (agentId !== targetAgent) {
        // Fast bypass — non-target spawn, don't touch.
        return;
      }

      // Build args view: prefer harness-provided args, else synthesize from
      // ctx so the router can still classify and stamp metadata.
      const args: JokerSpawnArgs = event?.args ?? {
        agent: agentId,
        request: event?.request ?? ctx?.request ?? "",
      };
      if (!args.agent) args.agent = agentId;
      if (typeof args.request !== "string") args.request = "";

      const decision = getRouter().routeJokerSpawn(args);

      // The harness reads back mutations on `event.args` for spawn-arg
      // hooks. Make sure the reference we mutated is the one the harness
      // owns (no-op when args === event.args).
      if (event && event.args !== args) {
        event.args = args;
      }

      // Decision is logged by the router itself when logDecisions=true.
      // Nothing to return — undefined keeps the spawn as-is (with our
      // in-place mutations applied).
      void decision;
    } catch (err) {
      // Fail-open: any error in the router degrades to vanilla JOKER.
      const msg = err instanceof Error ? err.message : String(err);
      try {
        api.logger.warn(`tsa-bmad-router fail-open on subagent_spawning: ${msg}`);
      } catch {
        /* swallow */
      }
    }
  });
}

// Default export for callers that import the module directly.
export default {
  registerBmadRouter,
  createBmadRouter,
  DEFAULT_CONFIG,
};
