/**
 * Smoke test offline — sem deploy, sem rede, sem LLM, sem fs real.
 *
 * Run: npm run build && npm run smoke
 *
 * Asserts:
 *   1. "responda boa noite" -> complexity=1 -> vanilla_joker, sem persona
 *   2. "estruture uma estrategia de vendas pra Q4 com 3 personas" ->
 *      complexity=3 -> phase=3-solutioning ("estruture" -> solutioning) ->
 *      persona winston-architect injected (monitorOnly=false here so we
 *      validate args mutation)
 *   3. "redesenhe a arquitetura do produto" -> complexity=3 ->
 *      phase=3-solutioning -> persona winston-architect
 *   4. monitorOnly=true: persona seria escolhida mas spawn args NAO sao
 *      mutados (decision.applied = shadow_*)
 *   5. agent != "0-joker" -> bypass total
 *   6. fallback: phase=1-analysis sem mary/james no fs -> walks pra outras
 *      fases e ainda resolve persona
 *   7. classifyComplexity: keyword único -> score 2 (não basta pra threshold 3)
 *   8. phase-hint metadata.bmad.nextPhase=4-implementation honrado
 *   9. createBmadRouter factory wires up corretamente
 */

import {
  BmadRouter,
  DEFAULT_CONFIG,
  InMemoryPersonaResolver,
  classifyComplexity,
  createBmadRouter,
} from "./plugin.js";
import type { JokerSpawnArgs, RouteDecision, RouterConfig } from "./plugin.js";

function fail(label: string, detail: string): never {
  // eslint-disable-next-line no-console
  console.error(`FAIL ${label}: ${detail}`);
  process.exit(1);
}

function ok(label: string): void {
  // eslint-disable-next-line no-console
  console.log(`PASS ${label}`);
}

function makeArgs(request: string, agent = "0-joker"): JokerSpawnArgs {
  return { agent, request };
}

function buildRouter(
  overrides: Partial<RouterConfig> = {},
  knownPersonas: string[] = [
    "mary-analyst",
    "james-strategist",
    "winston-architect",
    "sophia-designer",
    "carlos-impl",
    "diana-builder",
    "liam-reviewer",
    "olivia-qa",
  ],
): BmadRouter {
  const cfg: RouterConfig = { ...DEFAULT_CONFIG, ...overrides };
  const resolver = new InMemoryPersonaResolver(new Set(knownPersonas), cfg.bmadPersonasDir);
  return new BmadRouter(cfg, resolver, () => {
    /* silent */
  });
}

// ---------------------------------------------------------------------------
// 1. Trivial request -> vanilla
// ---------------------------------------------------------------------------

{
  const router = buildRouter({ monitorOnly: false, logDecisions: false });
  const args = makeArgs("responda boa noite");
  const d = router.routeJokerSpawn(args);
  if (d.applied !== "vanilla_joker") {
    fail("1-trivial", `expected vanilla_joker, got ${d.applied}`);
  }
  if (d.complexity !== 1) {
    fail("1-trivial", `expected complexity=1, got ${d.complexity}`);
  }
  if (args.systemPromptPrepend) {
    fail("1-trivial", `args mutated: ${args.systemPromptPrepend}`);
  }
  ok(`1-trivial (complexity=${d.complexity}, applied=${d.applied})`);
}

// ---------------------------------------------------------------------------
// 2. Strategy request -> 3-solutioning / winston-architect
//    ("estruture" hits the solutioning regex; complexity 3 from keyword + stakeholders + long)
// ---------------------------------------------------------------------------

{
  const router = buildRouter({ monitorOnly: false, logDecisions: false });
  const args = makeArgs(
    "estruture uma estrategia de vendas pra Q4 com 3 personas para a equipe comercial",
  );
  const d = router.routeJokerSpawn(args);
  if (d.complexity !== 3) {
    fail(
      "2-strategy",
      `expected complexity=3, got ${d.complexity} signals=${JSON.stringify(d.signals)}`,
    );
  }
  if (d.applied !== "persona_injected") {
    fail("2-strategy", `expected persona_injected, got ${d.applied}`);
  }
  if (!d.persona) fail("2-strategy", "persona null");
  if (!args.systemPromptPrepend || !args.systemPromptPrepend.includes(d.persona!.slug)) {
    fail("2-strategy", `prepend missing slug: ${args.systemPromptPrepend}`);
  }
  if (!args.metadata || !(args.metadata as { bmad?: unknown }).bmad) {
    fail("2-strategy", "metadata.bmad not stamped");
  }
  ok(`2-strategy (phase=${d.phase}, persona=${d.persona!.slug})`);
}

// ---------------------------------------------------------------------------
// 3. Architecture keyword -> 3-solutioning / winston-architect
// ---------------------------------------------------------------------------

{
  const router = buildRouter({ monitorOnly: false, logDecisions: false });
  const args = makeArgs(
    "redesenhe a arquitetura do produto pensando em escala para clientes enterprise",
  );
  const d = router.routeJokerSpawn(args);
  if (d.complexity !== 3) {
    fail("3-arch", `expected complexity=3, got ${d.complexity}`);
  }
  if (d.phase !== "3-solutioning") {
    fail("3-arch", `expected phase=3-solutioning, got ${d.phase}`);
  }
  if (!d.persona || d.persona.slug !== "winston-architect") {
    fail("3-arch", `expected winston-architect, got ${d.persona?.slug}`);
  }
  ok(`3-arch (persona=${d.persona!.slug})`);
}

// ---------------------------------------------------------------------------
// 4. monitorOnly -> shadow, args NOT mutated
// ---------------------------------------------------------------------------

{
  const router = buildRouter({ monitorOnly: true, logDecisions: false });
  const args = makeArgs(
    "monte um plano completo de roadmap de produto com framework de priorizacao para a diretoria",
  );
  const d = router.routeJokerSpawn(args);
  if (d.applied !== "shadow_persona_injected_monitor_only") {
    fail("4-shadow", `expected shadow_*, got ${d.applied}`);
  }
  if (!d.persona) fail("4-shadow", "persona null in shadow");
  if (args.systemPromptPrepend !== undefined) {
    fail("4-shadow", `args mutated despite monitorOnly: ${args.systemPromptPrepend}`);
  }
  if (args.metadata !== undefined) {
    fail("4-shadow", `metadata stamped despite monitorOnly`);
  }
  ok(`4-shadow (would-inject=${d.persona!.slug}, args clean)`);
}

// ---------------------------------------------------------------------------
// 5. Non-JOKER target -> bypass
// ---------------------------------------------------------------------------

{
  const router = buildRouter({ monitorOnly: false, logDecisions: false });
  const args = makeArgs("redesenhe a arquitetura completa do sistema", "0-hero");
  const d = router.routeJokerSpawn(args);
  if (d.applied !== "vanilla_joker") {
    fail("5-bypass", `expected vanilla_joker, got ${d.applied}`);
  }
  if (args.systemPromptPrepend) {
    fail("5-bypass", `args mutated for non-target agent`);
  }
  ok(`5-bypass (target=0-hero passes through)`);
}

// ---------------------------------------------------------------------------
// 6. Persona file missing for the picked phase -> walks fallback
// ---------------------------------------------------------------------------

{
  // Only winston-architect exists; nada de mary/james/sophia/carlos/etc.
  const router = buildRouter({ monitorOnly: false, logDecisions: false }, ["winston-architect"]);
  // 1-analysis-flavoured request — score 3 via keywords + stakeholders.
  // pickPhase will land on 1-analysis (no specific keyword regex hits);
  // mary/james ausentes -> fallback walk -> winston-architect.
  const args = makeArgs("monte uma estrategia comercial completa para clientes enterprise no Q4");
  const d = router.routeJokerSpawn(args);
  if (d.complexity !== 3) {
    fail("6-fallback", `expected complexity=3, got ${d.complexity}`);
  }
  if (!d.persona || d.persona.slug !== "winston-architect") {
    fail("6-fallback", `expected winston-architect fallback, got ${d.persona?.slug}`);
  }
  ok(`6-fallback (resolved=${d.persona!.slug})`);
}

// ---------------------------------------------------------------------------
// 7. classifyComplexity unit — keyword-only request still classifies as 2
// ---------------------------------------------------------------------------

{
  const { complexity, signals } = classifyComplexity("arquitetura");
  if (complexity !== 2) {
    fail(
      "7-classify",
      `expected complexity=2 (1 keyword hit, no other signals -> score=2), got ${complexity} signals=${JSON.stringify(signals)}`,
    );
  }
  ok(`7-classify (single keyword -> ${complexity})`);
}

// ---------------------------------------------------------------------------
// 8. Phase hint via metadata.bmad.nextPhase = 4-implementation
// ---------------------------------------------------------------------------

{
  const router = buildRouter({ monitorOnly: false, logDecisions: false });
  const args: JokerSpawnArgs = {
    agent: "0-joker",
    request: "execute a proxima fase da estrategia",
    metadata: { bmad: { nextPhase: "4-implementation" } },
  };
  const d = router.routeJokerSpawn(args);
  if (d.phase !== "4-implementation") {
    fail("8-hint", `expected phase=4-implementation, got ${d.phase}`);
  }
  if (!d.persona || d.persona.phase !== "4-implementation") {
    fail("8-hint", `expected impl persona, got ${d.persona?.slug}`);
  }
  ok(`8-hint (phase hint honored: ${d.persona!.slug})`);
}

// ---------------------------------------------------------------------------
// 9. Factory wires up — createBmadRouter returns a usable BmadRouter
// ---------------------------------------------------------------------------

{
  const router = createBmadRouter(
    { monitorOnly: false, logDecisions: false },
    {
      resolver: new InMemoryPersonaResolver(
        new Set(["mary-analyst"]),
        DEFAULT_CONFIG.bmadPersonasDir,
      ),
      logger: () => {
        /* silent */
      },
    },
  );
  const args = makeArgs("monte uma analise profunda da estrategia para clientes enterprise no Q4");
  const d: RouteDecision = router.routeJokerSpawn(args);
  if (d.applied !== "persona_injected") {
    fail("9-factory", `expected persona_injected, got ${d.applied}`);
  }
  if (d.persona?.slug !== "mary-analyst") {
    fail("9-factory", `expected mary-analyst, got ${d.persona?.slug}`);
  }
  ok(`9-factory (createBmadRouter -> ${d.persona!.slug})`);
}

// eslint-disable-next-line no-console
console.log("\nALL SMOKE TESTS PASSED");
process.exit(0);
