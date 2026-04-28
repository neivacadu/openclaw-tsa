import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Tools que ACE pode usar diretamente no main session (sem precisar delegar)
const ALLOWED_TOOLS_MAIN_SESSION = new Set([
  "sessions_spawn", // delegação · core do fluxo
  "agents_list", // listar subagents disponíveis
  "session_info", // info da sessão atual
  "settings_get", // ler settings.json
  "Read", // ler workspace files (memory, identidade, ROLES.md)
  "version_check", // info da versão
  "stop", // parar agent loop
]);

// Tools EXPLICITAMENTE bloqueadas no main session (forçam delegação)
const BLOCKED_TOOLS_MAIN_SESSION = new Set([
  "web_fetch",
  "web_search",
  "browser",
  "browser_open",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "playwright",
  "scrape",
  "WebFetch", // Anthropic-style naming
  "WebSearch",
  "BrowserOpen",
  "Edit", // Edit/Write fora workspace memory · usar HERO subagent
  "Write",
  "MultiEdit",
]);

// Tools que ACE pode usar mas com restrições (ex: Bash · só comandos lightweight)
const RESTRICTED_TOOLS_MAIN_SESSION = new Set([
  "Bash", // permite mas avisa pra preferir delegar
  "Exec",
]);

// Trivial Bash commands aceitos no main session (sem delegar)
const TRIVIAL_BASH_PATTERNS: RegExp[] = [
  /^\s*(echo|printf)\s/,
  /^\s*(ls|pwd|whoami|date|uptime|hostname)\b/,
  /^\s*cat\s+~?\/?(\.openclaw|workspace)/,
  /^\s*head\s/,
  /^\s*tail\s/,
  /^\s*git\s+(status|log|branch|remote)/,
  /^\s*systemctl\s+(status|is-active)/,
];

const LOG_PATH = join(process.env.HOME ?? homedir(), ".openclaw/logs/force-spawn.log");

async function appendLog(line: string): Promise<void> {
  try {
    await appendFile(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // fail-silent
  }
}

interface ToolCallSnapshot {
  toolName?: string;
  params?: { command?: string } & Record<string, unknown>;
}

interface PreToolCallContext {
  sessionKey?: string;
  parentSessionKey?: string;
  agentId?: string;
}

function isMainSession(ctx: PreToolCallContext): boolean {
  // Main session = não tem parent · OU sessionKey indica main agent não subagent
  if (ctx.parentSessionKey) return false;
  if (ctx.agentId && ctx.agentId !== "default" && ctx.agentId !== "ace" && ctx.agentId !== "0-ace")
    return false;
  // sessionKey patterns: "agent:main:<id>" = main, "agent:main:<id>:<sub>" = subagent
  const key = ctx.sessionKey ?? "";
  const colonCount = (key.match(/:/g) ?? []).length;
  // 2 colons = main, 3+ = subagent
  return colonCount <= 2;
}

function isTrivialBash(command: string): boolean {
  return TRIVIAL_BASH_PATTERNS.some((p) => p.test(command));
}

function buildBlockReason(toolName: string): string {
  return [
    `🔥 ACE não usa "${toolName}" diretamente no main session.`,
    `Tarefa complexa detectada · DELEGUE via sessions_spawn:`,
    ``,
    `   sessions_spawn(agentId="0-joker", prompt="<plano da tarefa>")`,
    ``,
    `JOKER vai cascatear: classifica → cria prompts → distribui pro HERO → HUNTER valida → JOKER sintetiza → ACE devolve.`,
    `Vide CLAUDE.md INSTRUÇÃO INVIOLÁVEL.`,
    ``,
    `Subagentes disponíveis: 0-joker (classify), 0-hero (executor), 0-creator (cria pipeline), 0-hunter (valida + Gold Standard).`,
  ].join(" ");
}

export function registerForceSpawn(api: any): void {
  api.on?.("before_tool_call", async (event: ToolCallSnapshot, ctx: PreToolCallContext) => {
    const toolName = event.toolName ?? "";
    if (!toolName) return null;

    // Só aplica em main session
    if (!isMainSession(ctx)) {
      return null;
    }

    // Allowed sempre
    if (ALLOWED_TOOLS_MAIN_SESSION.has(toolName)) {
      return null;
    }

    // Bloqueado sempre
    if (BLOCKED_TOOLS_MAIN_SESSION.has(toolName)) {
      const reason = buildBlockReason(toolName);
      await appendLog(
        `BLOCK tool=${toolName} session=${ctx.sessionKey ?? "?"} reason=executor_in_main`,
      );
      return {
        block: true,
        blockReason: reason,
      };
    }

    // Restricted: Bash trivial OK · scripts/network bloqueado
    if (RESTRICTED_TOOLS_MAIN_SESSION.has(toolName)) {
      const command = String(event.params?.command ?? "");
      if (isTrivialBash(command)) {
        await appendLog(
          `ALLOW restricted tool=${toolName} cmd_head="${command.slice(0, 80)}" trivial=true`,
        );
        return null;
      }
      // Não trivial · bloqueia
      const reason =
        buildBlockReason(toolName) + ` Comando "${command.slice(0, 80)}" não é trivial · delegue.`;
      await appendLog(
        `BLOCK tool=${toolName} cmd_head="${command.slice(0, 80)}" reason=non_trivial_bash`,
      );
      return {
        block: true,
        blockReason: reason,
      };
    }

    // Default: pass-through (tools desconhecidas não bloqueia)
    return null;
  });
}
