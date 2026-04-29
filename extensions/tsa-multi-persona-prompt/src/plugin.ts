import { readFile, stat } from "node:fs/promises";

interface PluginConfig {
  agentId?: string;
  promptFilePath?: string;
}

const DEFAULT_AGENT_ID = "0-ace";
const DEFAULT_PROMPT_PATH = "/home/ace-tsia/.openclaw/workspace/output-styles/turbo.md";

let targetAgentId: string = DEFAULT_AGENT_ID;
let promptFilePath: string = DEFAULT_PROMPT_PATH;
let cachedPrompt: string | null = null;
let lastMtime: number = 0;

async function loadPrompt(): Promise<string | null> {
  try {
    const st = await stat(promptFilePath);
    const mtime = st.mtimeMs;
    if (mtime !== lastMtime || cachedPrompt === null) {
      cachedPrompt = await readFile(promptFilePath, "utf8");
      lastMtime = mtime;
    }
    return cachedPrompt;
  } catch {
    // fail-silent · prompt missing never breaks build flow
    return null;
  }
}

export function registerMultiPersonaPrompt(api: any): void {
  const cfg: PluginConfig = (api?.config ?? {}) as PluginConfig;
  targetAgentId = cfg.agentId || DEFAULT_AGENT_ID;
  promptFilePath = cfg.promptFilePath || DEFAULT_PROMPT_PATH;

  // Warm cache (fire-and-forget · async)
  void loadPrompt();

  api.on?.("before_prompt_build", async (event: any, _ctx: any) => {
    const agentId = (event?.agentId ?? "") as string;
    if (agentId !== targetAgentId) return undefined;

    const prompt = await loadPrompt();
    if (!prompt) return undefined;

    return { prependSystemContext: prompt };
  });
}
