import { spawn } from "node:child_process";

export type HookPayload = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_id?: string;
  session_id?: string;
};

export type HookResult = {
  blocked: boolean;
  /** Reason text extracted from stderr when exit code === 2. */
  reason?: string;
  /** Why we treated the run as pass-through when not blocked (timeout, error). */
  fallbackReason?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
};

export type RunHookOptions = {
  /** Hard timeout. If the script doesn't exit within this window we kill it
   * and treat the call as pass-through (fail-safe — we never want a hung
   * hook to deadlock tool execution). */
  timeoutMs: number;
  /**
   * If true, never report blocked=true even if the hook exits 2. Used for the
   * log-edit-intent fire-and-forget mirror.
   */
  neverBlock?: boolean;
};

/**
 * Spawn a bash hook script and translate its exit code into a HookResult.
 *
 * Contract (matches block-destructive.sh / Hermes PreToolUse convention):
 *   - exit 0 -> ALLOWED
 *   - exit 2 -> BLOCKED, with a "BLOCKED: <reason>" line on stderr
 *   - any other exit code -> treated as pass-through with fallbackReason set
 *
 * The payload is delivered three ways for compatibility with both the Hermes
 * style (stdin JSON) and the legacy bash style (env vars):
 *   - JSON on stdin
 *   - OPENCLAW_TOOL_NAME / OPENCLAW_TOOL_INPUT / OPENCLAW_AGENT_ID env vars
 */
export async function runBashHook(
  scriptPath: string,
  payload: HookPayload,
  opts: RunHookOptions,
): Promise<HookResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(scriptPath, [], {
        env: {
          ...process.env,
          OPENCLAW_TOOL_NAME: String(payload.tool_name ?? ""),
          OPENCLAW_TOOL_INPUT: safeJson(payload.tool_input ?? {}),
          OPENCLAW_AGENT_ID: String(payload.agent_id ?? ""),
          OPENCLAW_SESSION_ID: String(payload.session_id ?? ""),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        blocked: false,
        fallbackReason: `spawn error: ${(err as Error).message}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      proc.stdin?.write(safeJson(payload));
      proc.stdin?.end();
    } catch {
      // ignore stdin write failures — script may have already exited
    }

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore kill errors
      }
      settled = true;
      resolve({
        blocked: false,
        fallbackReason: `timeout after ${opts.timeoutMs}ms`,
        stdout,
        stderr,
      });
    }, opts.timeoutMs);

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        blocked: false,
        fallbackReason: `hook error: ${err.message}`,
        stdout,
        stderr,
      });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 2 && !opts.neverBlock) {
        const match = stderr.match(/BLOCKED:\s*(.+)/i);
        resolve({
          blocked: true,
          reason: (match?.[1] ?? "blocked").trim(),
          exitCode: code,
          stdout,
          stderr,
        });
        return;
      }
      if (code === 0) {
        resolve({ blocked: false, exitCode: code, stdout, stderr });
        return;
      }
      resolve({
        blocked: false,
        fallbackReason: `unexpected exit code ${code}`,
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
