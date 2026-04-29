import { appendFile } from "node:fs/promises";

interface PluginConfig {
  agentId?: string;
  fallbackContent?: string;
  logFilePath?: string;
}

const DEFAULT_LOG_PATH = "/home/ace-tsia/.openclaw/hooks/output-filter.log";
const DEFAULT_AGENT_ID = "0-ace";
const DEFAULT_FALLBACK = "[ACE block ausente — verificar transcript]";

async function appendLog(logPath: string, msg: string): Promise<void> {
  const ts = new Date().toISOString();
  try {
    await appendFile(logPath, `[${ts}] ${msg}\n`);
  } catch {
    // fail-silent · log IO never breaks tool flow
  }
}

export function registerAceOutputFilter(api: any, config: any): void {
  const cfg: PluginConfig = (config ?? {}) as PluginConfig;
  const targetAgentId = cfg.agentId || DEFAULT_AGENT_ID;
  const fallbackContent = cfg.fallbackContent || DEFAULT_FALLBACK;
  const logPath = cfg.logFilePath || DEFAULT_LOG_PATH;

  void appendLog(
    logPath,
    `Plugin tsa-ace-output-filter activated · agentId=${targetAgentId} · log=${logPath}`,
  );

  api.on?.("message_sending", async (event: any, _ctx: any) => {
    const eventAgentId = (event?.agentId ?? "") as string;
    if (eventAgentId !== targetAgentId) return undefined;

    const content = (event?.content as string) || "";

    // Caso 1: já é texto limpo, sem markers
    if (!content.includes("<<")) return undefined;

    // Caso 2: tem o bloco ACE — extrair
    const match = content.match(/<<ACE>>([\s\S]*?)<<END>>/);
    if (match) {
      const aceText = match[1].trim();
      await appendLog(logPath, `EXTRACTED <<ACE>> · ${aceText.length} chars`);
      return { content: aceText };
    }

    // Caso 3: tem markers mas falta <<ACE>> — fallback
    await appendLog(
      logPath,
      `FALLBACK · markers presentes mas <<ACE>> ausente · raw: ${content.substring(0, 200)}...`,
    );
    return { content: fallbackContent };
  });
}
