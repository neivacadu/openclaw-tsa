import { watchFile } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import * as YAML from "yaml";

interface RedirectRule {
  from: string;
  to: string;
  reason?: string;
}

interface RoutingConfig {
  version?: number;
  redirects?: RedirectRule[];
  unmapped_legacy_action?: "block" | "warn" | "passthrough";
}

interface PluginConfig {
  routingFilePath?: string;
  logFilePath?: string;
}

const DEFAULT_ROUTING_PATH = "/home/ace-tsia/.openclaw/workspace/agents/roles-routing.yaml";
const DEFAULT_LOG_PATH = "/home/ace-tsia/.openclaw/hooks/redirect-audit.log";

let routing: RoutingConfig | null = null;
let logPath: string = DEFAULT_LOG_PATH;
let routingPath: string = DEFAULT_ROUTING_PATH;

async function appendLog(msg: string): Promise<void> {
  const ts = new Date().toISOString();
  try {
    await appendFile(logPath, `[${ts}] ${msg}\n`);
  } catch {
    // fail-silent · log IO never breaks tool flow
  }
}

async function loadRouting(): Promise<void> {
  try {
    const raw = await readFile(routingPath, "utf8");
    const parsed = YAML.parse(raw) as RoutingConfig;
    routing = parsed ?? { redirects: [], unmapped_legacy_action: "passthrough" };
    const count = Array.isArray(routing.redirects) ? routing.redirects.length : 0;
    await appendLog(
      `LOADED routing v${routing.version ?? "?"} · ${count} redirects · unmapped=${routing.unmapped_legacy_action ?? "passthrough"}`,
    );
  } catch (err) {
    routing = null;
    await appendLog(`ERROR loading routing: ${(err as Error).message}`);
  }
}

function findRule(requestedAgent: string): RedirectRule | undefined {
  if (!routing?.redirects) return undefined;
  return routing.redirects.find((r) => r.from === requestedAgent);
}

export function registerSubagentRedirect(api: any): void {
  // Pull config (api.config preferred · fallback to defaults)
  const cfg: PluginConfig = (api?.config ?? {}) as PluginConfig;
  routingPath = cfg.routingFilePath || DEFAULT_ROUTING_PATH;
  logPath = cfg.logFilePath || DEFAULT_LOG_PATH;

  // Initial load (fire-and-forget · async)
  void loadRouting();

  // Hot reload on file change
  watchFile(routingPath, { interval: 2000 }, () => {
    void appendLog(`Routing file changed, reloading`);
    void loadRouting();
  });

  void appendLog(`Plugin activated · routing=${routingPath} · log=${logPath}`);

  api.on?.("before_tool_call", async (event: any, _ctx: any) => {
    const toolName = event?.toolName ?? "";
    if (toolName !== "Agent" && toolName !== "sessions_spawn") {
      return undefined;
    }
    if (!routing) return undefined;

    const params = (event?.params ?? {}) as Record<string, unknown>;
    const requestedAgent = (params.subagent_type ?? params.agentId) as string | undefined;
    if (!requestedAgent || typeof requestedAgent !== "string") return undefined;

    // Already canonical (0-joker, 0-hero, 0-creator, 0-hunter)
    if (requestedAgent.startsWith("0-")) {
      return undefined;
    }

    const rule = findRule(requestedAgent);

    if (!rule) {
      const policy = routing.unmapped_legacy_action ?? "passthrough";
      if (policy === "block") {
        await appendLog(`BLOCK · unmapped: ${requestedAgent} (tool=${toolName})`);
        return {
          block: true,
          blockReason: `Subagent "${requestedAgent}" não mapeado em roles-routing.yaml. Use 0-joker, 0-hero, 0-creator ou 0-hunter.`,
        };
      }
      await appendLog(`WARN · unmapped passthrough: ${requestedAgent} (tool=${toolName})`);
      return undefined;
    }

    const newParams: Record<string, unknown> = { ...params };
    if ("subagent_type" in newParams) newParams.subagent_type = rule.to;
    if ("agentId" in newParams) newParams.agentId = rule.to;

    await appendLog(
      `REDIRECT · ${requestedAgent} → ${rule.to} (${rule.reason ?? "mapped"}) · tool=${toolName}`,
    );

    return { params: newParams };
  });
}
