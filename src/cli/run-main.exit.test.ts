import process from "node:process";
import { CommanderError } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, shouldStartProxyForCli } from "./run-main.js";

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());
const closeActiveMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const hasMemoryRuntimeMock = vi.hoisted(() => vi.fn(() => false));
const ensureTaskRegistryReadyMock = vi.hoisted(() => vi.fn());
const startTaskRegistryMaintenanceMock = vi.hoisted(() => vi.fn());
const outputRootHelpMock = vi.hoisted(() => vi.fn());
const outputPrecomputedRootHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedBrowserHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const buildProgramMock = vi.hoisted(() => vi.fn());
const getProgramContextMock = vi.hoisted(() => vi.fn(() => null));
const registerCoreCliByNameMock = vi.hoisted(() => vi.fn());
const registerSubCliByNameMock = vi.hoisted(() => vi.fn());
const restoreTerminalStateMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn(() => ({})));
const startProxyMock = vi.hoisted(() =>
  vi.fn<(config: unknown) => Promise<unknown>>(async () => null),
);
const stopProxyMock = vi.hoisted(() => vi.fn<(handle: unknown) => Promise<void>>(async () => {}));
const maybeRunCliInContainerMock = vi.hoisted(() =>
  vi.fn<
    (argv: string[]) => { handled: true; exitCode: number } | { handled: false; argv: string[] }
  >((argv: string[]) => ({ handled: false, argv })),
);

vi.mock("./route.js", () => ({
  tryRouteCli: tryRouteCliMock,
}));

vi.mock("./container-target.js", () => ({
  maybeRunCliInContainer: maybeRunCliInContainerMock,
  parseCliContainerArgs: (argv: string[]) => ({ ok: true, container: null, argv }),
}));

vi.mock("./dotenv.js", () => ({
  loadCliDotEnv: loadDotEnvMock,
}));

vi.mock("../infra/env.js", () => ({
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: ensurePathMock,
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: assertRuntimeMock,
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagers: closeActiveMemorySearchManagersMock,
}));

vi.mock("../plugins/memory-state.js", () => ({
  hasMemoryRuntime: hasMemoryRuntimeMock,
}));

vi.mock("../tasks/task-registry.js", () => ({
  ensureTaskRegistryReady: ensureTaskRegistryReadyMock,
}));

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  startTaskRegistryMaintenance: startTaskRegistryMaintenanceMock,
}));

vi.mock("./program/root-help.js", () => ({
  outputRootHelp: outputRootHelpMock,
}));

vi.mock("./root-help-metadata.js", () => ({
  outputPrecomputedBrowserHelpText: outputPrecomputedBrowserHelpTextMock,
  outputPrecomputedRootHelpText: outputPrecomputedRootHelpTextMock,
}));

vi.mock("./program.js", () => ({
  buildProgram: buildProgramMock,
}));

vi.mock("./program/program-context.js", () => ({
  getProgramContext: getProgramContextMock,
}));

vi.mock("./program/command-registry.js", () => ({
  registerCoreCliByName: registerCoreCliByNameMock,
}));

vi.mock("./program/register.subclis.js", () => ({
  registerSubCliByName: registerSubCliByNameMock,
}));

vi.mock("../terminal/restore.js", () => ({
  restoreTerminalState: restoreTerminalStateMock,
}));

vi.mock("../config/io.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: startProxyMock,
  stopProxy: stopProxyMock,
}));

function makeProxyHandle() {
  return {
    port: 19876,
    proxyUrl: "http://127.0.0.1:19876",
    pid: 1234,
    injectedProxyUrl: "http://127.0.0.1:19876",
    envSnapshot: {
      http_proxy: undefined,
      https_proxy: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      GLOBAL_AGENT_HTTP_PROXY: undefined,
      GLOBAL_AGENT_HTTPS_PROXY: undefined,
      GLOBAL_AGENT_FORCE_GLOBAL_AGENT: undefined,
      no_proxy: undefined,
      NO_PROXY: undefined,
      GLOBAL_AGENT_NO_PROXY: undefined,
    },
    stop: vi.fn(async () => {}),
    kill: vi.fn(),
  };
}

describe("runCli exit behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasMemoryRuntimeMock.mockReturnValue(false);
    outputPrecomputedBrowserHelpTextMock.mockReturnValue(false);
    loadConfigMock.mockReturnValue({});
    startProxyMock.mockResolvedValue(null);
    stopProxyMock.mockResolvedValue(undefined);
    outputPrecomputedRootHelpTextMock.mockReturnValue(false);
    getProgramContextMock.mockReturnValue(null);
    delete process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH;
  });

  it("does not force process.exit after successful routed command", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(ensureTaskRegistryReadyMock).not.toHaveBeenCalled();
    expect(startTaskRegistryMaintenanceMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("renders browser help from startup metadata without building the full program", async () => {
    outputPrecomputedBrowserHelpTextMock.mockReturnValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "browser", "--help"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "browser",
      "--help",
    ]);
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputPrecomputedBrowserHelpTextMock).toHaveBeenCalledTimes(1);
    expect(outputRootHelpMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("does not start the proxy for local gateway client commands", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "status"]);

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(stopProxyMock).not.toHaveBeenCalled();
  });

  it.each([
    ["gateway runtime", ["node", "openclaw", "gateway", "run"]],
    ["bare gateway runtime", ["node", "openclaw", "gateway"]],
    ["node runtime", ["node", "openclaw", "node", "run"]],
    ["local agent runtime", ["node", "openclaw", "agent", "--local"]],
    ["provider inference", ["node", "openclaw", "infer", "web", "fetch", "https://example.com"]],
    ["model command", ["node", "openclaw", "models", "auth", "login", "openai"]],
    ["plugin command", ["node", "openclaw", "plugins", "marketplace", "list"]],
    ["skill command", ["node", "openclaw", "skills", "search", "browser"]],
    ["update command", ["node", "openclaw", "update", "check"]],
    ["channel probe", ["node", "openclaw", "channels", "status", "--probe"]],
    ["channel capabilities probe", ["node", "openclaw", "channels", "capabilities"]],
    ["directory plugin command", ["node", "openclaw", "directory", "peers", "list"]],
    ["message plugin command", ["node", "openclaw", "message", "send", "--to", "demo"]],
    ["unknown plugin command", ["node", "openclaw", "googlemeet", "login"]],
  ])("starts proxy routing for %s", (_name, argv) => {
    expect(shouldStartProxyForCli(argv)).toBe(true);
  });

  it.each([
    ["root help", ["node", "openclaw", "--help"]],
    ["root version", ["node", "openclaw", "--version"]],
    ["status", ["node", "openclaw", "status"]],
    ["health", ["node", "openclaw", "health"]],
    ["gateway status", ["node", "openclaw", "gateway", "status"]],
    ["gateway health", ["node", "openclaw", "gateway", "health"]],
    ["remote agent control-plane", ["node", "openclaw", "agent", "run"]],
    ["chat control-plane", ["node", "openclaw", "chat"]],
    ["terminal control-plane", ["node", "openclaw", "terminal"]],
    ["config", ["node", "openclaw", "config", "get", "proxy.enabled"]],
    ["completion", ["node", "openclaw", "completion", "zsh"]],
    ["debug proxy cli", ["node", "openclaw", "proxy", "start"]],
    ["agents list", ["node", "openclaw", "agents", "list"]],
    ["models list", ["node", "openclaw", "models", "list"]],
    ["models status without live probe", ["node", "openclaw", "models", "status"]],
  ])("skips proxy routing for %s", (_name, argv) => {
    expect(shouldStartProxyForCli(argv)).toBe(false);
  });

  it("starts the proxy for network-capable commands by default", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "plugins", "marketplace", "list"]);

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it("starts the proxy for unknown plugin commands by default", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "googlemeet", "login"]);

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it("fails protected commands when proxy activation fails", async () => {
    startProxyMock.mockRejectedValueOnce(new Error("proxy: enabled but no HTTP proxy URL"));

    await expect(runCli(["node", "openclaw", "gateway", "run"])).rejects.toThrow(
      "proxy: enabled but no HTTP proxy URL",
    );

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(stopProxyMock).not.toHaveBeenCalled();
  });

  it("fails protected commands when config cannot be loaded for proxy startup", async () => {
    loadConfigMock.mockImplementationOnce(() => {
      throw new Error("config parse failed");
    });

    await expect(runCli(["node", "openclaw", "gateway", "run"])).rejects.toThrow(
      "config parse failed",
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
  });

  it("stops the proxy after normal gateway runtime completion", async () => {
    const handle = makeProxyHandle();
    startProxyMock.mockResolvedValueOnce(handle);
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "gateway", "run"]);

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
    expect(stopProxyMock).toHaveBeenCalledOnce();
    expect(stopProxyMock).toHaveBeenCalledWith(handle);
  });

  it("stops the proxy and exits after SIGINT", async () => {
    const handle = makeProxyHandle();
    startProxyMock.mockResolvedValueOnce(handle);

    let resolveRoute: (value: boolean) => void = () => {};
    tryRouteCliMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveRoute = resolve;
      }),
    );

    const processOnceSpy = vi.spyOn(process, "once");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string) => {
      void code;
      return undefined as never;
    }) as typeof process.exit);

    try {
      const runPromise = runCli(["node", "openclaw", "gateway", "run"]);
      await vi.waitFor(() => {
        expect(processOnceSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
      });

      const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
      if (typeof sigintHandler !== "function") {
        throw new Error("SIGINT handler was not registered");
      }
      sigintHandler();

      await vi.waitFor(() => {
        expect(stopProxyMock).toHaveBeenCalledWith(handle);
      });
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(130);
      });

      resolveRoute(true);
      await runPromise;
      expect(stopProxyMock).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
      processOnceSpy.mockRestore();
    }
  });

  it("synchronously kills the proxy during hard process exit", async () => {
    const handle = makeProxyHandle();
    startProxyMock.mockResolvedValueOnce(handle);

    let resolveRoute: (value: boolean) => void = () => {};
    tryRouteCliMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveRoute = resolve;
      }),
    );

    const processOnceSpy = vi.spyOn(process, "once");
    try {
      const runPromise = runCli(["node", "openclaw", "gateway", "run"]);
      await vi.waitFor(() => {
        expect(processOnceSpy.mock.calls.filter(([event]) => event === "exit")).toHaveLength(2);
      });

      const exitHandler = processOnceSpy.mock.calls.findLast(([event]) => event === "exit")?.[1];
      if (typeof exitHandler !== "function") {
        throw new Error("exit handler was not registered");
      }
      exitHandler(0 as never);

      expect(handle.kill).toHaveBeenCalledWith("SIGTERM");
      resolveRoute(true);
      await runPromise;
      expect(stopProxyMock).not.toHaveBeenCalledWith(handle);
    } finally {
      processOnceSpy.mockRestore();
    }
  });

  it("renders root help without building the full program", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "--help"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "--help"]);
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("closes memory managers when a runtime was registered", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    hasMemoryRuntimeMock.mockReturnValue(true);

    await runCli(["node", "openclaw", "status"]);

    expect(closeActiveMemorySearchManagersMock).toHaveBeenCalledTimes(1);
  });

  it("returns after a handled container-target invocation", async () => {
    maybeRunCliInContainerMock.mockReturnValueOnce({ handled: true, exitCode: 0 });

    await runCli(["node", "openclaw", "--container", "demo", "status"]);

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "--container",
      "demo",
      "status",
    ]);
    expect(loadDotEnvMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
  });

  it("propagates a handled container-target exit code", async () => {
    const exitCode = process.exitCode;
    maybeRunCliInContainerMock.mockReturnValueOnce({ handled: true, exitCode: 7 });

    await runCli(["node", "openclaw", "--container", "demo", "status"]);

    expect(process.exitCode).toBe(7);
    process.exitCode = exitCode;
  });

  it("swallows Commander parse exits after recording the exit code", async () => {
    const exitCode = process.exitCode;
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "status" }],
      parseAsync: vi
        .fn()
        .mockRejectedValueOnce(
          new CommanderError(1, "commander.excessArguments", "too many arguments for 'status'"),
        ),
    });

    await expect(runCli(["node", "openclaw", "status"])).resolves.toBeUndefined();

    expect(registerSubCliByNameMock).toHaveBeenCalledWith(expect.anything(), "status");
    expect(process.exitCode).toBe(1);
    process.exitCode = exitCode;
  });

  it("loads the real primary command before rendering command help", async () => {
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "doctor" }],
      parseAsync: vi.fn().mockResolvedValueOnce(undefined),
    });
    const ctx = { programVersion: "0.0.0-test" };
    getProgramContextMock.mockReturnValueOnce(ctx as never);

    await runCli(["node", "openclaw", "doctor", "--help"]);

    expect(registerCoreCliByNameMock).toHaveBeenCalledWith(expect.anything(), ctx, "doctor", [
      "node",
      "openclaw",
      "doctor",
      "--help",
    ]);
    expect(registerSubCliByNameMock).toHaveBeenCalledWith(expect.anything(), "doctor");
  });

  it("restores terminal state before uncaught CLI exits", async () => {
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "status" }],
      parseAsync: vi.fn().mockResolvedValueOnce(undefined),
    });

    const processOnSpy = vi.spyOn(process, "on");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    const handler = processOnSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1];
    expect(typeof handler).toBe("function");

    try {
      expect(() => (handler as (error: unknown) => void)(new Error("boom"))).toThrow(
        "process.exit(1)",
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[openclaw] Uncaught exception:",
        expect.stringContaining("boom"),
      );
      expect(restoreTerminalStateMock).toHaveBeenCalledWith("uncaught exception", {
        resumeStdinIfPaused: false,
      });
    } finally {
      if (typeof handler === "function") {
        process.off("uncaughtException", handler);
      }
      consoleErrorSpy.mockRestore();
      exitSpy.mockRestore();
      processOnSpy.mockRestore();
    }
  });
});
