/**
 * Smoke tests for tsa-context-preload.
 * Builds a temp workspace, runs loadContext(), asserts shape + budget + format.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContextPreload, estimateTokens, type ContextPreloadConfig } from "./index.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

async function touch(p: string, content: string, mtimeMs: number) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
  const t = new Date(mtimeMs);
  await fs.utimes(p, t, t);
}

function makeConfig(root: string): ContextPreloadConfig {
  return {
    memoryDaysBack: 3,
    artifactsHoursBack: 24,
    lastSessionTurns: 20,
    maxTokens: 5000,
    memoryDir: path.join(root, "workspace", "memory"),
    artifactsDirs: [path.join(root, "workspace")],
    artifactExtensions: ["html", "pdf", "doc", "md", "png", "jpg"],
    publicUrlPrefix: "https://ace.caduneiva.com/",
    publicUrlBasePath: path.join(root, "www", "ace") + "/",
    sessionsDir: path.join(root, "sessions"),
    agentsToInject: ["0-ace"],
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tsa-ctxpreload-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("ContextPreload — smoke", () => {
  it("includes recent memories, artifacts, session turns; excludes >3d items", async () => {
    const now = Date.now();
    // 5 memory MDs — 3 recent, 2 old (>3d)
    await touch(
      path.join(tmp, "workspace/memory/m1.md"),
      "# decisão GPU 2 com Qwen 3.6\nbody",
      now - 1 * DAY,
    );
    await touch(
      path.join(tmp, "workspace/memory/m2.md"),
      "# HUNTER=Sonnet anti-bias\nbody",
      now - 2 * DAY,
    );
    await touch(
      path.join(tmp, "workspace/memory/m3.md"),
      "# 4 plugins novos Camada 1\nbody",
      now - 0.1 * DAY,
    );
    await touch(path.join(tmp, "workspace/memory/old1.md"), "# decisão antiga\n", now - 10 * DAY);
    await touch(path.join(tmp, "workspace/memory/old2.md"), "# bem velha\n", now - 30 * DAY);

    // 3 HTML artifacts — 2 recent, 1 old
    await touch(
      path.join(tmp, "workspace/aula-vendas.html"),
      "<html>" + "x".repeat(45000) + "</html>",
      now - 6 * HOUR,
    );
    await touch(path.join(tmp, "workspace/proposta.pdf"), "x".repeat(180000), now - 12 * HOUR);
    await touch(path.join(tmp, "workspace/old.html"), "<html>old</html>", now - 48 * HOUR);

    // public-mapped artifact
    await touch(
      path.join(tmp, "www/ace/aula-vendas-ace-tsa.html"),
      "<html>pub</html>",
      now - 2 * HOUR,
    );
    // and link it via artifactsDirs (point to www/ace too)
    const cfg = makeConfig(tmp);
    cfg.artifactsDirs.push(path.join(tmp, "www", "ace"));

    // 1 session jsonl with 6 turns; expect tail of 5
    const lines = [
      { role: "user", text: "pode atualizar a página de vendas?" },
      { role: "assistant", text: "atualizei. https://ace.caduneiva.com/aula-vendas-ace-tsa.html" },
      { role: "user", text: "precisa de ilustrações" },
      { role: "assistant", text: "vou propor briefings visuais" },
      { role: "user", text: "vou voltar amanhã" },
      { role: "assistant", text: "combinado, até lá" },
    ];
    await touch(
      path.join(tmp, "sessions/abc123.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n"),
      now - 30 * 60 * 1000,
    );

    const plugin = new ContextPreload(cfg);
    const res = await plugin.loadContext({ agentId: "0-ace" });

    expect(res.metadata.skipped).toBe(false);
    expect(res.systemPromptAppend).toBeTruthy();
    const out = res.systemPromptAppend!;

    // Markdown sections present
    expect(out).toContain("## Contexto recuperado (auto)");
    expect(out).toContain("### Memórias últimos 3 dias");
    expect(out).toContain("### Artefatos gerados últimas 24h");
    expect(out).toContain("### Última sessão");

    // Recent items present
    expect(out).toContain("decisão GPU 2 com Qwen 3.6");
    expect(out).toContain("HUNTER=Sonnet anti-bias");
    expect(out).toContain("4 plugins novos Camada 1");
    expect(out).toContain("aula-vendas.html");
    expect(out).toContain("proposta.pdf");

    // Old items excluded
    expect(out).not.toContain("decisão antiga");
    expect(out).not.toContain("bem velha");
    expect(out).not.toContain("old.html");

    // Public URL mapping worked for the www/ace artifact
    expect(out).toContain("https://ace.caduneiva.com/aula-vendas-ace-tsa.html");

    // Session tail compact format (user/ace lines)
    expect(out).toContain("- user: pode atualizar a página de vendas?");
    expect(out).toContain("- ace: ");
    expect(out).toContain("vou voltar amanhã");

    // Counts
    expect(res.metadata.memories).toBe(3);
    expect(res.metadata.artifacts).toBeGreaterThanOrEqual(2);
    expect(res.metadata.sessionTurns).toBe(6);

    // Budget respected
    expect(res.metadata.tokensInjected).toBeLessThanOrEqual(cfg.maxTokens);
    expect(estimateTokens(out)).toBeLessThanOrEqual(cfg.maxTokens + 5);
  });

  it("respects budget aggressively when content overflows", async () => {
    const now = Date.now();
    // 50 memories with long first lines → would blow past 200 tokens easily
    for (let i = 0; i < 50; i++) {
      await touch(
        path.join(tmp, `workspace/memory/m${i}.md`),
        "# " + "x".repeat(800) + "\n",
        now - (i % 3) * HOUR,
      );
    }
    const cfg = makeConfig(tmp);
    cfg.maxTokens = 300;
    const res = await new ContextPreload(cfg).loadContext({ agentId: "0-ace" });
    expect(res.metadata.tokensInjected).toBeLessThanOrEqual(300);
    expect(res.metadata.memories).toBeLessThan(50);
  });

  it("skips when agent not targeted", async () => {
    const cfg = makeConfig(tmp);
    const res = await new ContextPreload(cfg).loadContext({ agentId: "9-other" });
    expect(res.metadata.skipped).toBe(true);
    expect(res.metadata.reason).toBe("agent-not-targeted");
    expect(res.systemPromptAppend).toBeUndefined();
  });

  it("does not throw when workspace is empty", async () => {
    const cfg = makeConfig(tmp);
    const res = await new ContextPreload(cfg).loadContext({ agentId: "0-ace" });
    expect(res.metadata.skipped).toBe(false);
    expect(res.systemPromptAppend).toContain("## Contexto recuperado (auto)");
  });
});
