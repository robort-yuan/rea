import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { spawn } from "@lydell/node-pty";
import { decode as decodeToon } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CLIENT_LOCATION_ENVIRONMENT } from "../../fixtures/clientEnvironment.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const decisionMarker = "REA_SETUP_DECISION:";
const decisionSchema = z.object({
  approved: z.boolean(),
  selectedActionIds: z.array(z.string()),
  cancelled: z.boolean().optional(),
});

const actions = [
  {
    id: "configure_client:codex",
    kind: "configure_client",
    label: "Codex",
    target: "/isolated/.codex/config.toml",
    detail: "Add the REA MCP registration for Codex.",
    external: false,
    operation: "create",
  },
  {
    id: "install_skill",
    kind: "install_skill",
    label: "REA reverse-engineering skill",
    target: "/isolated/.agents/skills/reverse-engineering/SKILL.md",
    detail: "Install the bundled reverse-engineering skill.",
    external: false,
    operation: "install",
  },
  {
    id: "install_hopper",
    kind: "install_hopper",
    label: "Hopper deep-analysis provider",
    target: "/isolated/Applications/Hopper Disassembler.app",
    detail: "Install the verified Hopper package.",
    external: true,
    operation: "install",
  },
] as const;

const clientStates = [
  {
    client: {
      name: "codex",
      format: "toml",
      configPath: [".codex", "config.toml"],
      marker: [".codex"],
    },
    detected: true,
    configured: false,
    status: "needs_configuration",
  },
  {
    client: {
      name: "opencode",
      format: "opencode",
      configPath: [".config", "opencode", "opencode.json"],
      marker: [".config", "opencode"],
    },
    detected: false,
    configured: false,
    status: "missing",
  },
] as const;

const agentActions = actions.filter(({ kind }) => kind !== "install_hopper");

const runSetupDryRunInTty = async (
  home: string,
  arguments_: readonly string[],
): Promise<{ readonly exitCode: number; readonly output: string }> => {
  const terminal = spawn(
    process.execPath,
    ["scripts/rea.mjs", "setup", "--dry-run", ...arguments_],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        REA_LOG_LEVEL: "silent",
        NO_COLOR: "1",
      },
      name: "xterm-256color",
      cols: 120,
      rows: 40,
    },
  );
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error(`TTY dry run timed out after output:\n${output}`));
    }, 15_000);
    terminal.onExit(({ exitCode: code }) => {
      clearTimeout(timeout);
      resolvePromise(code);
    });
  });
  return { exitCode, output };
};

describe("TTY setup dry run", () => {
  it("prints the plan and no-mutation notice for a TTY dry run", async () => {
    const home = await createTestTempDirectory("rea-cli-setup-dry-run-");
    const { exitCode, output } = await runSetupDryRunInTty(home, [
      "--client",
      "codex",
      "--skill=false",
    ]);

    expect(exitCode, output).toBe(0);
    expect(output).toContain("CREATE  Codex");
    expect(output).toContain(join(home, ".codex/config.toml"));
    expect(output).toContain("Dry run complete. No changes were made.");
    await expect(
      access(join(home, ".codex/config.toml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("shows the refusal instead of a blocked skill plan for a TTY dry run", async () => {
    const home = await createTestTempDirectory("rea-cli-setup-linked-dry-run-");
    const managed = join(home, "managed-skill");
    const linked = join(home, ".claude/skills/reverse-engineer-anything");
    const original = "user-managed skill bytes\n";
    await mkdir(managed);
    await writeFile(join(managed, "SKILL.md"), original);
    await mkdir(dirname(linked), { recursive: true });
    await symlink(
      managed,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );

    const { exitCode, output } = await runSetupDryRunInTty(home, [
      "--client",
      "claude_code",
    ]);

    expect(exitCode, output).toBe(1);
    expect(output).toContain("Skill directory is a symbolic link.");
    expect(output).toContain(linked);
    expect(output).toContain("--skill=false");
    expect(output).not.toContain("REA setup plan");
    expect(output).not.toContain("Install or update the REA skill");
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(managed, "SKILL.md"), "utf8")).toBe(original);
    expect(await readdir(managed)).toEqual(["SKILL.md"]);
    await expect(access(join(home, ".claude.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("interactive setup journey", () => {
  it("shows detected and absent clients without preselecting detected clients", async () => {
    const result = await runJourney(
      [
        step("Which agents should use REA?", "\u001b[B"),
        step("Not detected · configuration is still available", "\r"),
      ],
      false,
      [actions[0]],
    );
    expect(result.output).toContain("Detected: Codex");
    expect(result.output).toContain(
      "Not detected · configuration is still available",
    );
    expect(result.output).toContain("Which agents should use REA?");
    expect(result.output).not.toContain("What should REA set up?");
    expect(result.decision.selectedActionIds).toEqual([]);
  });

  it("selects an absent OpenCode client and bundles its skill", async () => {
    const result = await runJourney(
      [
        step("Which agents should use REA?", "\u001b[B \r"),
        step("Apply these 2 changes?", "\r"),
      ],
      false,
      [
        {
          ...actions[0],
          id: "configure_client:opencode",
          label: "OpenCode",
          target: "/isolated/.config/opencode/opencode.json",
        },
        actions[1],
      ],
    );
    expect(result.output).toContain("CREATE  OpenCode");
    expect(result.decision.selectedActionIds).toEqual([
      "configure_client:opencode",
      "install_skill",
    ]);
    expect(result.decision.approved).toBe(true);
  });

  it("shows the launcher, backup, and path before final approval", async () => {
    const result = await runJourney(
      [
        step("Which agents should use REA?", " \r"),
        step("Apply these 2 changes?", "\r"),
      ],
      false,
      [
        {
          ...actions[0],
          operation: "update",
          backupPath: "/isolated/.codex/config.toml.bak",
          commands: ["npx -y rea-agents@3.2.1 mcp"],
        },
        actions[1],
      ],
    );
    expect(result.output).toContain("/isolated/.codex/config.toml.bak");
    expect(result.output).toContain("command: npx -y rea-agents@3.2.1 mcp");
    expect(result.output.indexOf("command:")).toBeLessThan(
      result.output.indexOf("Apply these 2 changes?"),
    );
  });

  it("treats final No as cancellation", async () => {
    const result = await runJourney([
      step("Which agents should use REA?", " \r"),
      step("Apply these 2 changes?", "\u001b[D\r"),
    ]);
    expect(result.output).toContain("Setup cancelled. No changes were made.");
    expect(result.decision.cancelled).toBe(true);
    expect(result.decision.approved).toBe(false);
  });

  it("restores the terminal after Ctrl-C during selection", async () => {
    const result = await runJourney([
      step("Which agents should use REA?", "\u0003"),
    ]);
    expect(result.output).toContain("\u001b[?25h");
    expect(result.decision.cancelled).toBe(true);
  });

  it("can install the skill for CLI use without an agent registration", async () => {
    const result = await runJourney([
      step("Which agents should use REA?", "\r"),
      step("Install the guided REA skill for CLI use?", "\u001b[D\r"),
      step("Apply this change?", "\r"),
    ]);
    expect(result.decision.selectedActionIds).toEqual(["install_skill"]);
    expect(result.decision.approved).toBe(true);
  });

  it("offers Hopper separately and defaults against installing it", async () => {
    const result = await runJourney(
      [
        step("Which agents should use REA?", " \r"),
        step("Install Hopper for deep binary analysis?", "\r"),
        step("Apply these 2 changes?", "\r"),
      ],
      false,
      actions,
    );
    expect(result.decision.selectedActionIds).toEqual([
      "configure_client:codex",
      "install_skill",
    ]);
  });

  it("uses sequential prompts without auto-selecting detected agents in accessible mode", async () => {
    const result = await runJourney(
      [
        step("Configure Codex?", "\r"),
        step("Configure OpenCode?", "\u001b[A\r"),
        step("Apply this change?", "\r"),
      ],
      true,
      [{ ...actions[0], id: "configure_client:opencode", label: "OpenCode" }],
    );
    expect(result.decision.selectedActionIds).toEqual([
      "configure_client:opencode",
    ]);
  });

  it("preselects only a prior REA registration", async () => {
    const result = await runJourney(
      [
        step("Which agents should use REA?", "\r"),
        step("Apply these 2 changes?", "\r"),
      ],
      false,
      agentActions,
      ["codex"],
    );
    expect(result.decision.selectedActionIds).toEqual([
      "configure_client:codex",
      "install_skill",
    ]);
  });
});

describe("interactive setup completion", () => {
  it.each([
    { npmCommand: "", userAgent: "", launcher: "rea" },
    {
      npmCommand: "exec",
      userAgent: "npm/10.9.0 node/v24.11.0 linux x64",
      launcher: "npx rea-agents",
    },
    {
      npmCommand: "exec",
      userAgent: "bun/1.4.2 npm/? node/v26.3.0 linux x64",
      launcher: "bunx rea-agents",
    },
  ])(
    "prints an available next command for $launcher invocation",
    async ({ npmCommand, userAgent, launcher }) => {
      const { stderr } = await execute(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            'import { renderInteractiveSetupResult } from "./dist/cli/interactiveSetup.js";',
            "renderInteractiveSetupResult({",
            '  status: "ready",',
            "  plannedActions: [],",
            "  appliedActions: [],",
            '  clients: { codex: { status: "configured" } },',
            "  doctor: {",
            "    healthy: true,",
            '    availableProviders: ["hopper", "ghidra"],',
            '    hopperPath: "/Applications/Hopper",',
            "    checks: [],",
            '    providerInspections: [{ id: "ghidra", available: true }],',
            '    identity: { skill: { state: "aligned" }, registrations: [{ client: "codex", state: "aligned" }] },',
            "  },",
            "});",
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) =>
                  !["npm_command", "npm_config_user_agent"].includes(
                    key.toLowerCase(),
                  ),
              ),
            ),
            npm_command: npmCommand,
            npm_config_user_agent: userAgent,
            NO_COLOR: "1",
          },
        },
      );

      expect(stderr).toContain("What you can do now");
      expect(stderr).toContain("Deep analysis: Hopper and Ghidra");
      expect(stderr).toContain("Agent access: Codex");
      expect(stderr).toContain(
        "Guided reverse-engineering workflows: installed",
      );
      expect(stderr).toContain(`CLI: ${launcher} analyze /path/to/app`);
      expect(stderr).toContain(
        'Try in Codex: "Explain how a feature works in /path/to/app and show the evidence."',
      );
    },
  );
});

describe("non-interactive setup output", () => {
  it.each([["--format", "json"], ["--json"]])(
    "keeps explicitly structured terminal output free of human summaries: %s",
    async (...format) => {
      await withTerminalSetup(
        ["--dry-run", "--client", "codex", "--skill=false", ...format],
        ({ output, stderr, exitCode }) => {
          expect(exitCode).toBe(0);
          expect(stderr).toBe("");
          expect(JSON.parse(output)).toMatchObject({
            status: "planned",
            appliedActions: [],
          });
        },
        { captureStderr: true },
      );
    },
    60_000,
  );

  it("returns a structured result when setup output is piped", async () => {
    const home = await createTestTempDirectory("rea-setup-piped-");
    const { stdout, stderr } = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "setup",
        "--dry-run",
        "--client",
        "codex",
        "--skill=false",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...isolatedClientEnvironment(),
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          NO_COLOR: "1",
        },
      },
    );
    expect(stderr).toBe("");
    expect(decodeToon(stdout)).toMatchObject({
      status: "planned",
      appliedActions: [],
    });
    await expect(
      access(join(home, ".codex", "config.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});

describe("non-interactive setup in a terminal", () => {
  it("summarizes an approved setup", async () => {
    await withTerminalSetup(
      ["--yes", "--client", "codex", "--skill=false"],
      async ({ output, exitCode, home }) => {
        expect(exitCode).toBe(0);
        expect(output).toContain("Restart Codex to load REA.");
        await expect(
          access(join(home, ".codex", "config.toml")),
        ).resolves.toBeUndefined();
      },
    );
  }, 60_000);

  it("shows the pending plan when stdin is not a terminal", async () => {
    await withTerminalSetup(
      ["--client", "codex", "--skill=false"],
      async ({ output, exitCode, home }) => {
        const config = join(home, ".codex", "config.toml");
        expect(exitCode).toBe(1);
        expect(output).toContain("Ready to review");
        expect(output).toContain(config);
        expect(output).toContain(
          "Review the setup plan, then rerun interactively or with --yes.",
        );
        await expect(access(config)).rejects.toThrow();
      },
      { redirectStdin: true },
    );
  }, 60_000);

  // A later client's write fails after an earlier client was configured.
  // /proc rejects file creation even for root, so this needs Linux.
  it.runIf(process.platform === "linux")(
    "names changes already applied and the client that failed",
    async () => {
      await withTerminalSetup(
        ["--yes", "--client", "codex", "--client", "opencode", "--skill=false"],
        async ({ output, exitCode, home }) => {
          const config = join(home, ".codex", "config.toml");
          expect(exitCode).toBe(1);
          expect(output).toContain("Already applied");
          expect(output).toContain(config);
          expect(output).toContain("Failed configuration");
          expect(output).toContain("FAILED  OpenCode");
          expect(output).toContain(
            "Agent configuration could not be updated. Check file permissions",
          );
          expect(output.indexOf("Already applied")).toBeLessThan(
            output.indexOf("Failed configuration"),
          );
          expect(output).not.toContain("Planned changes not completed");
          await expect(access(config)).resolves.toBeUndefined();
        },
        {
          prepare: async (home) => {
            await mkdir(join(home, ".config"), { recursive: true });
            await symlink(
              "/proc/self/fdinfo",
              join(home, ".config", "opencode"),
            );
          },
        },
      );
    },
    60_000,
  );
});

interface TerminalSetupRun {
  readonly output: string;
  readonly exitCode: number;
  readonly home: string;
  readonly stderr: string | undefined;
}

/** Drop the developer's client locations so setup resolves only the temporary home. */
const isolatedClientEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const name of CLIENT_LOCATION_ENVIRONMENT) delete environment[name];
  return environment;
};

interface TerminalSetupOptions {
  readonly prepare?: (home: string) => Promise<void>;
  /** Give setup a terminal stdout while leaving stdin redirected. */
  readonly redirectStdin?: boolean;
  readonly captureStderr?: boolean;
}

/**
 * Launch setup with the parent's terminal stdout and a non-terminal stdin.
 * A direct pseudo-terminal would make stdin a terminal and start the
 * interactive journey instead.
 */
const redirectedStdinLauncher = (
  args: readonly string[],
  stderrPath?: string,
): string =>
  [
    'import { spawn } from "node:child_process";',
    'import { openSync, closeSync } from "node:fs";',
    `const stderr = ${stderrPath === undefined ? '"inherit"' : `openSync(${JSON.stringify(stderrPath)}, "wx")`};`,
    `const child = spawn(process.execPath, ${JSON.stringify(["scripts/rea.mjs", "setup", ...args])}, {`,
    "  cwd: process.cwd(),",
    "  env: process.env,",
    '  stdio: ["ignore", "inherit", stderr],',
    "});",
    'if (typeof stderr === "number") closeSync(stderr);',
    'for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {',
    "  process.on(signal, () => child.kill(signal));",
    "}",
    'child.on("exit", (code) => process.exit(code ?? 1));',
  ].join("\n");

/** Run the public setup command under a real pseudo-terminal in an isolated home. */
const withTerminalSetup = async (
  args: readonly string[],
  assert: (run: TerminalSetupRun) => void | Promise<void>,
  options?: TerminalSetupOptions,
): Promise<void> => {
  const home = await createTestTempDirectory("rea-cli-setup-terminal-");
  const stderrPath =
    options?.captureStderr === true ? join(home, "setup.stderr") : undefined;
  try {
    await options?.prepare?.(home);
    const { output, exitCode } = await new Promise<{
      output: string;
      exitCode: number;
    }>((resolvePromise, reject) => {
      let output = "";
      const terminal = spawn(
        process.execPath,
        options?.redirectStdin === true || options?.captureStderr === true
          ? [
              "--input-type=module",
              "--eval",
              redirectedStdinLauncher(args, stderrPath),
            ]
          : ["scripts/rea.mjs", "setup", ...args],
        {
          cwd: process.cwd(),
          env: {
            ...isolatedClientEnvironment(),
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            NO_COLOR: "1",
            TERM: "xterm-256color",
          },
          name: "xterm-256color",
          cols: 400,
          rows: 60,
        },
      );
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error(`Timed out after output:\n${output}`));
      }, 50_000);
      terminal.onData((data) => {
        output += data;
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        resolvePromise({ output, exitCode });
      });
    });
    await assert({
      output,
      exitCode,
      home,
      stderr:
        stderrPath === undefined
          ? undefined
          : await readFile(stderrPath, "utf8"),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

interface JourneyStep {
  readonly prompt: string;
  readonly input: string;
}

interface JourneyResult {
  readonly output: string;
  readonly decision: z.infer<typeof decisionSchema>;
}

const step = (prompt: string, input: string): JourneyStep => ({
  prompt,
  input,
});

const runJourney = async (
  steps: readonly JourneyStep[],
  accessible = false,
  journeyActions: readonly object[] = agentActions,
  initialClientIds: readonly string[] = [],
): Promise<JourneyResult> => {
  const isolatedHome = await createTestTempDirectory("rea-cli-setup-test-");
  const script = [
    'import { confirmInteractiveSetup } from "./dist/cli/interactiveSetup.js";',
    `const actions = ${JSON.stringify(journeyActions)};`,
    `const context = ${JSON.stringify({ stage: "select", clientStates, selectedClientIds: initialClientIds, clientSelectionAllowed: true })};`,
    `let decision = await confirmInteractiveSetup(actions, ${JSON.stringify(accessible)}, context);`,
    "if (!decision.cancelled && decision.selectedActionIds.length > 0) {",
    "  const selected = new Set(decision.selectedActionIds);",
    `  decision = await confirmInteractiveSetup(actions.filter(({ id }) => selected.has(id)), ${JSON.stringify(accessible)}, { ...context, stage: "confirm", clientSelectionAllowed: false });`,
    "}",
    `process.stdout.write(${JSON.stringify(`\n${decisionMarker}`)} + JSON.stringify(decision) + "\\n");`,
  ].join("\n");

  return new Promise<JourneyResult>((resolvePromise, reject) => {
    let output = "";
    let nextStep = 0;
    let settled = false;
    const terminal = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          NO_COLOR: "1",
          TERM: "xterm-256color",
        },
        name: "xterm-256color",
        cols: 120,
        rows: 40,
      },
    );
    const timeout = setTimeout(() => {
      terminal.kill();
      finish(new Error(`Timed out after output:\n${output}`));
    }, 10_000);

    terminal.onData((data) => {
      output += data;
      const pending = steps[nextStep];
      if (pending !== undefined && output.includes(pending.prompt)) {
        nextStep += 1;
        terminal.write(pending.input);
      }
    });
    terminal.onExit(({ exitCode }) => {
      if (exitCode !== 0) {
        finish(
          new Error(`Setup journey exited ${String(exitCode)}:\n${output}`),
        );
        return;
      }
      if (nextStep !== steps.length) {
        finish(new Error(`Setup journey missed an interaction:\n${output}`));
        return;
      }
      const markerIndex = output.lastIndexOf(decisionMarker);
      if (markerIndex === -1) {
        finish(new Error(`Setup journey returned no decision:\n${output}`));
        return;
      }
      const raw = output.slice(markerIndex + decisionMarker.length);
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      const serialized =
        jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart
          ? raw.slice(jsonStart, jsonEnd + 1)
          : raw.split(/\r?\n/u, 1)[0];
      if (serialized === undefined) {
        finish(
          new Error(`Setup journey returned an empty decision:\n${output}`),
        );
        return;
      }
      try {
        finish(undefined, {
          output,
          decision: decisionSchema.parse(JSON.parse(serialized)),
        });
      } catch (cause: unknown) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });

    function finish(error?: Error, result?: JourneyResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void rm(isolatedHome, { recursive: true, force: true }).finally(() => {
        if (error !== undefined) reject(error);
        else if (result !== undefined) resolvePromise(result);
        else reject(new Error("Setup journey completed without a result"));
      });
    }
  });
};

it("names every failed client with its own recovery reason in terminal remediation", async () => {
  const opencode = {
    ...actions[0],
    id: "configure_client:opencode",
    label: "OpenCode",
    target: "/isolated/.config/opencode/opencode.json",
  };
  const result = {
    status: "needs_human",
    plannedActions: [actions[0], opencode],
    appliedActions: [],
    clients: {
      codex: { status: "failed", reason: "write" },
      opencode: {
        status: "failed",
        reason: "rollback",
        backupPath: "/isolated/opencode.json.rea.backup",
        failure: {
          kind: "restore",
          path: "/isolated/.config/opencode/opencode.json",
          detail: "restore denied",
        },
      },
    },
    doctor: {},
    clientStates: [],
    remediation: "Agent configuration could not be updated.",
  };
  const stderr = await renderSummary(result);
  expect(stderr).toContain("FAILED  Codex");
  expect(stderr).toContain("/isolated/.codex/config.toml");
  expect(stderr).toContain("FAILED  OpenCode");
  // Setup's remediation names only the first failure; the second keeps its own.
  expect(stderr).toContain("restore denied");
  expect(stderr).toContain("/isolated/opencode.json.rea.backup");
  expect(stderr.indexOf("FAILED  OpenCode")).toBeLessThan(
    stderr.indexOf("restore denied"),
  );
});

it("shows the backup setup actually wrote for a client kept after a later failure", async () => {
  const updatedCodex = {
    ...actions[0],
    operation: "update",
    backupPath: "/isolated/.codex/config.toml.rea.planned",
  };
  const opencode = {
    ...actions[0],
    id: "configure_client:opencode",
    label: "OpenCode",
    target: "/isolated/.config/opencode/opencode.json",
  };
  const result = {
    status: "needs_human",
    plannedActions: [updatedCodex, opencode],
    appliedActions: ["configured_codex"],
    clients: {
      codex: {
        status: "configured",
        backupPath: "/isolated/.codex/config.toml.rea.3f9a",
      },
      opencode: { status: "failed", reason: "write" },
    },
    doctor: {},
    clientStates: [],
    remediation: "Agent configuration could not be updated.",
  };
  const stderr = await renderSummary(result);
  expect(stderr).toContain("UPDATE  Codex");
  expect(stderr).toContain("backup: /isolated/.codex/config.toml.rea.3f9a");
  expect(stderr).not.toContain("config.toml.rea.planned");
  expect(stderr.indexOf("backup: /isolated/.codex")).toBeLessThan(
    stderr.indexOf("Failed configuration"),
  );
});

it("shows planned actions with their full disclosures when setup stops before reporting any outcomes", async () => {
  const hopper = {
    ...actions[2],
    networkOrigins: ["https://www.hopperapp.com"],
    integrity: "sha256:0000",
    commands: ["/usr/bin/installer -pkg Hopper.pkg"],
  };
  const result = {
    status: "needs_human",
    plannedActions: [actions[0], hopper],
    appliedActions: [],
    clients: {},
    doctor: {},
    clientStates: [],
    remediation: "Setup host cleanup failed",
  };
  const stderr = await renderSummary(result);
  expect(stderr).toContain("Planned changes not completed");
  expect(stderr).toContain("CREATE  Codex");
  expect(stderr).toContain("/isolated/.codex/config.toml");
  expect(stderr).toContain("Add the REA MCP registration for Codex.");
  expect(stderr).toContain("network: https://www.hopperapp.com");
  expect(stderr).toContain("integrity: sha256:0000");
  expect(stderr).toContain("command: /usr/bin/installer -pkg Hopper.pkg");
  expect(stderr).toContain("external software");
  expect(stderr.indexOf("Planned changes not completed")).toBeLessThan(
    stderr.indexOf("Setup host cleanup failed"),
  );
});

/** Render a terminal summary through the built CLI module. */
const renderSummary = async (result: unknown): Promise<string> => {
  const { stderr } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import { renderTerminalSetupSummary } from "./dist/cli/interactiveSetup.js";',
        `renderTerminalSetupSummary(${JSON.stringify(result)});`,
      ].join("\n"),
    ],
    { cwd: process.cwd(), env: { ...process.env, NO_COLOR: "1" } },
  );
  return stderr;
};
