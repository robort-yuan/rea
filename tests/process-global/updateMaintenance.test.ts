import {
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
  access,
} from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { err, ok } from "../../src/domain/result.js";
import { runUpdate, type UpdateResult } from "../../src/application/Update.js";
import { PRODUCT_IDENTITY } from "../../src/identity.js";
import { supportedClients } from "../../src/application/SupportedClients.js";
import {
  existingMaintenanceScope,
  planIntegrationMaintenance,
} from "../../src/application/UpdateMaintenance.js";
import {
  runUpdateCommand,
  UPDATE_COMMAND_OUTPUT_BYTES,
  systemUpdateHost,
} from "../../src/application/UpdateRuntime.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const entryPoint = resolve("scripts/rea.mjs");
let home: string;

beforeEach(async () => {
  home = await createTestTempDirectory("rea-update-maintenance-");
  for (const [name, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    CLAUDE_CONFIG_DIR: home,
    CODEX_HOME: join(home, ".codex"),
    COPILOT_HOME: join(home, ".copilot"),
    GROK_HOME: join(home, ".grok"),
    SAND_DATA_ROOT: join(home, ".grokbot"),
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.jsonc"),
    OMP_PROFILE: undefined,
    PI_CODING_AGENT_DIR: undefined,
    PI_CONFIG_DIR: undefined,
    PI_PROFILE: undefined,
  }))
    vi.stubEnv(name, value);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const writeClient = async (id: string, content: string): Promise<string> => {
  const client = supportedClients(home).find(({ name }) => name === id);
  if (client === undefined) throw new Error(`Unknown test client ${id}`);
  await mkdir(dirname(client.configPath), { recursive: true });
  await writeFile(client.configPath, content);
  return client.configPath;
};

const writeSkill = async (content: string): Promise<string> => {
  const path = join(
    home,
    ".agents",
    "skills",
    PRODUCT_IDENTITY.skillName,
    "SKILL.md",
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
};

const staleCodex =
  '[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents@0.1.0", "mcp"]\n';
const action = {
  id: "configure_client:codex",
  kind: "configure_client",
  label: "Codex",
  target: "/test/.codex/config.toml",
  detail: "Refresh the pinned REA version",
  external: false,
  operation: "update",
  backupPath: "/test/.codex/config.toml.rea.backup",
  commands: ["rea mcp"],
};

describe("OMP integration maintenance", () => {
  it("refreshes an OMP entry that enabledServers forces on", async () => {
    const entry = { type: "stdio", command: entryPoint, args: ["mcp"] };
    await writeClient(
      "omp",
      JSON.stringify({ mcpServers: { rea: { ...entry, enabled: false } } }),
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: [] });
    await writeClient(
      "omp",
      JSON.stringify({
        mcpServers: { rea: { ...entry, enabled: false } },
        enabledServers: ["rea"],
      }),
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: ["omp"] });
  });

  it("preserves Grok Build disabled_mcp_servers during maintenance planning", async () => {
    // Strict identity: a user-disabled integration must never be selected
    // for maintenance, even with a healthy owned entry underneath.
    const registration = `[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entryPoint)}, "mcp"]\nstartup_timeout_sec = 30\n`;
    const configPath = await writeClient(
      "grok_build",
      `disabled_mcp_servers = ["rea", "other"]\n${registration}`,
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: [] });
    expect(await readFile(configPath, "utf8")).toContain(
      'disabled_mcp_servers = ["rea", "other"]',
    );
    await writeFile(
      configPath,
      `disabled_mcp_servers = ["other"]\n${registration}`,
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: ["grok_build"] });
  });
});

describe("maintenance activation and layered configuration", () => {
  it("leaves a natively disabled ZCode registration outside maintenance", async () => {
    const configPath = await writeClient(
      "zcode",
      JSON.stringify({
        mcp: {
          servers: {
            rea: { command: entryPoint, args: ["mcp"], enable: false },
          },
        },
      }),
    );
    const original = await readFile(configPath, "utf8");
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: [] });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("selects a ZCode registration loaded from the same-scope fallback", async () => {
    await writeClient("zcode", JSON.stringify({ mcp: { servers: {} } }));
    const fallbackPath = join(home, ".agents", "mcp.json");
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      fallbackPath,
      JSON.stringify({
        mcpServers: { rea: { command: entryPoint, args: ["mcp"] } },
      }),
    );

    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: ["zcode"] });
  });

  it("selects an enabled registration inherited through layered OpenCode files", async () => {
    const directory = join(home, ".config", "opencode");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({
        mcp: { rea: { type: "local", command: [entryPoint, "mcp"] } },
      }),
    );
    await writeClient("opencode", JSON.stringify({ theme: "user-selected" }));
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: ["opencode"] });
  });
});

describe("existing REA integration maintenance", () => {
  it("selects owned registrations while preserving unconfigured, foreign, and disabled choices", async () => {
    await writeClient("codex", staleCodex);
    await writeClient("claude_code", '{"mcpServers":{}}');
    await writeClient(
      "cursor",
      '{"mcpServers":{"rea":{"command":"foreign-server","args":[]}}}',
    );
    await writeClient(
      "opencode",
      '{"mcp":{"rea":{"type":"local","command":["npx","-y","rea-agents@0.1.0","mcp"],"enabled":false}}}',
    );
    await writeClient(
      "vscode",
      JSON.stringify({
        servers: { rea: { type: "stdio", command: entryPoint, args: ["mcp"] } },
      }),
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: ["codex", "vscode"],
      skill: false,
      skillDestinations: [],
    });
  });

  it("does not install a missing skill or overwrite an unrelated skill", async () => {
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: [],
      skill: false,
      skillDestinations: [],
    });
    await writeSkill("---\nname: another-skill\n---\nUser-authored content\n");
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: [],
      skill: false,
      skillDestinations: [],
    });
  });

  it("includes an existing REA skill and leaves files untouched", async () => {
    const path = await writeSkill(
      `---\nname: ${PRODUCT_IDENTITY.skillName}\nmetadata:\n  version: "1"\n---\n# REA\n`,
    );
    const original = await readFile(path, "utf8");
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: [],
      skill: true,
      skillDestinations: [
        {
          client: "shared",
          path: join(home, ".agents", "skills", PRODUCT_IDENTITY.skillName),
        },
      ],
    });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("skips setup entirely when there is no existing integration", async () => {
    let invoked = false;
    const result = await planIntegrationMaintenance(
      home,
      entryPoint,
      process.env,
      async () => {
        invoked = true;
        return err("Unexpected setup");
      },
    );
    expect(result).toEqual({ status: "current", plannedActions: [] });
    expect(invoked).toBe(false);
  });

  it("returns exact backup and command evidence with a scoped unapplied setup command", async () => {
    await writeClient("codex", staleCodex);
    const recorded: string[][] = [];
    const result = await planIntegrationMaintenance(
      home,
      entryPoint,
      process.env,
      async (command) => {
        recorded.push([...command]);
        return ok(
          JSON.stringify({ status: "planned", plannedActions: [action] }),
        );
      },
    );
    expect(recorded).toEqual([
      [
        process.execPath,
        entryPoint,
        "setup",
        "--client",
        "codex",
        "--skill=false",
        "--dry-run",
        "--json",
      ],
    ]);
    expect(result).toEqual({
      status: "planned",
      scope: { clients: ["codex"], skill: false, skillDestinations: [] },
      command: recorded[0]?.slice(0, -2),
      plannedActions: [action],
    });
  });

  it.each([
    "{broken",
    JSON.stringify({ status: "ready", plannedActions: [action] }),
    JSON.stringify({
      status: "planned",
      plannedActions: [{ ...action, kind: "install_hopper", external: true }],
    }),
    JSON.stringify({
      status: "planned",
      plannedActions: [{ ...action, id: "configure_client:cursor" }],
    }),
  ])("rejects malformed or out-of-scope subprocess plans", async (output) => {
    await writeClient("codex", staleCodex);
    expect(
      await planIntegrationMaintenance(
        home,
        entryPoint,
        process.env,
        async () => ok(output),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("preserves actual setup failure diagnostics", async () => {
    await writeClient("codex", staleCodex);
    expect(
      await planIntegrationMaintenance(
        home,
        entryPoint,
        process.env,
        async () => err("EACCES /test/.codex/config.toml"),
      ),
    ).toEqual({
      status: "unavailable",
      remediation: "EACCES /test/.codex/config.toml",
    });
  });
});

describe("updated executable maintenance planning", () => {
  it("runs real setup as a noninteractive dry run and creates no new integrations or backups", async () => {
    const configPath = await writeClient("codex", staleCodex);
    const untouched = await writeClient("claude_code", '{"mcpServers":{}}');
    const skillContent = `---\nname: ${PRODUCT_IDENTITY.skillName}\nmetadata:\n  version: "1"\n---\n# REA\n`;
    const skillPath = await writeSkill(skillContent);
    vi.stubEnv("npm_command", "exec");
    const result = await planIntegrationMaintenance(
      home,
      entryPoint,
      process.env,
      (command) => runUpdateCommand(command, process.env),
    );
    expect(result).toMatchObject({
      status: "planned",
      scope: {
        clients: ["codex"],
        skill: true,
        skillDestinations: [{ client: "shared", path: dirname(skillPath) }],
      },
    });
    if (result.status !== "planned") throw new Error(JSON.stringify(result));
    expect(result.plannedActions).toEqual([
      expect.objectContaining({
        id: "configure_client:codex",
        kind: "configure_client",
      }),
      expect.objectContaining({
        id: "install_skill",
        kind: "install_skill",
        target: dirname(skillPath),
      }),
    ]);
    expect(await readFile(configPath, "utf8")).toBe(staleCodex);
    expect(await readFile(untouched, "utf8")).toBe('{"mcpServers":{}}');
    expect(await readFile(skillPath, "utf8")).toBe(skillContent);
    await expect(access(`${configPath}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(`${skillPath}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(home, ".claude", "skills", PRODUCT_IDENTITY.skillName)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("update subprocess boundaries", () => {
  cliTest("exposes update in CLI help", async ({ cli }) => {
    const help = await cli.run({
      arguments: ["--help"],
      environment: process.env,
    });
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toMatch(/^\s{2}update\s/mu);
    expect(help.stdout).not.toMatch(/^\s{2}upgrade\s/mu);
  });

  cliTest("rejects the removed upgrade CLI command", async ({ cli }) => {
    const removed = await cli.run({
      arguments: ["upgrade", "--json"],
      environment: process.env,
    });
    expect(removed.exitCode, removed.stderr).toBe(1);
    expect(removed.json).toMatchObject({ code: "COMMAND_NOT_FOUND" });
  });
  it("captures output through stream closure and keeps arguments literal", async () => {
    const literal = 'space and $(echo bad); & | "quotes"';
    const result = await runUpdateCommand(
      [
        process.execPath,
        "-e",
        'process.stdout.write("x".repeat(1024 * 1024) + process.argv[1])',
        literal,
      ],
      process.env,
    );
    expect(result).toEqual(ok(`${"x".repeat(1024 * 1024)}${literal}`));
  });

  it("reports actual stderr and launch failures", async () => {
    await expect(
      runUpdateCommand(
        [
          process.execPath,
          "-e",
          'process.stderr.write("EACCES /test/install"); process.exitCode = 2',
        ],
        process.env,
      ),
    ).resolves.toEqual(err("EACCES /test/install"));
    const missing = await runUpdateCommand(
      [join(home, "missing-executable")],
      process.env,
    );
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.error).toContain("ENOENT");
  });

  it("verifies the requested package entry rather than PATH's rea", async () => {
    const packageRoot = join(home, "package");
    const script = join(packageRoot, "scripts", "rea.mjs");
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, 'process.stdout.write("3.3.0\\n")');
    await expect(
      systemUpdateHost(packageRoot, home).installedVersion({
        manager: "npm",
        prefix: home,
        packageRoot,
      }),
    ).resolves.toEqual(ok("3.3.0"));
  });
});

const createBunUpdateFixture = async (
  root: string,
  {
    bunVersion,
    installOutputBytes,
    installExitCode,
    project,
  }: {
    readonly bunVersion: string;
    readonly installOutputBytes: number;
    readonly installExitCode: number;
    readonly project: "global" | "ancestor";
  },
) => {
  const bunInstall = join(root, "home", ".bun");
  const globalDirectory = join(bunInstall, "install", "global");
  // Without a global manifest, Bun installs into the nearest ancestor project.
  const projectDirectory =
    project === "global" ? globalDirectory : join(root, "home");
  const packageRoot = join(
    projectDirectory,
    "node_modules",
    PRODUCT_IDENTITY.packageName,
  );
  const versionPath = join(root, "installed-version");
  const logPath = join(root, "bun-invocations.jsonl");
  await mkdir(globalDirectory, { recursive: true });
  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await writeFile(
    join(projectDirectory, "package.json"),
    '{"dependencies":{"rea-agents":"3.2.1"}}\n',
  );
  if (project === "ancestor") {
    await writeFile(join(projectDirectory, "bun.lock"), "{}\n");
    // Bun leaves a migrated npm lockfile in place; this one records nothing.
    await writeFile(
      join(projectDirectory, "package-lock.json"),
      '{"lockfileVersion":3,"requires":true,"packages":{}}\n',
    );
  }
  await writeFile(versionPath, "3.2.1");
  await writeFile(
    join(packageRoot, "scripts", "rea.mjs"),
    `import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(versionPath)}, "utf8") + "\\n");\n`,
  );
  const binDirectory = join(root, "bin");
  const recorder = join(binDirectory, "record-bun.mjs");
  await mkdir(binDirectory);
  await writeFile(
    recorder,
    [
      'import { appendFileSync, writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd(), globalDirectory: process.env.BUN_INSTALL_GLOBAL_DIR }) + "\\n");`,
      `if (JSON.stringify(args) === '["--version"]') console.log(${JSON.stringify(bunVersion)});`,
      `else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(["info", PRODUCT_IDENTITY.packageName, "dist-tags.latest", "--json"]))}) process.stdout.write('"3.3.0"\\n');`,
      `else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(["add", "--global", "--ignore-scripts", `${PRODUCT_IDENTITY.packageName}@3.3.0`]))}) process.stderr.write('x'.repeat(${installOutputBytes}), () => { ${installExitCode === 0 ? `writeFileSync(${JSON.stringify(versionPath)}, "3.3.0");` : "process.exitCode = 2;"} });`,
      "else process.exitCode = 2;",
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    await writeFile(
      join(binDirectory, "bun.cmd"),
      `@"${process.execPath}" "${recorder}" %*\r\n`,
    );
  } else {
    await writeFile(
      join(binDirectory, "bun"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\n`,
      { mode: 0o755 },
    );
  }
  return {
    bunInstall,
    globalDirectory,
    projectDirectory,
    packageRoot,
    versionPath,
    logPath,
    binDirectory,
  };
};

const readCommandInvocations = async (logPath: string): Promise<unknown[]> => {
  try {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return [];
    throw cause;
  }
};

const linuxUserPrefixFixture = async (
  root: string,
  npmReportsUserPrefix = false,
) => {
  const selectedHome = join(root, "home");
  const prefix = join(selectedHome, ".local");
  const packageRoot = join(
    prefix,
    "lib",
    "node_modules",
    PRODUCT_IDENTITY.packageName,
  );
  const packageEntry = join(packageRoot, "scripts", "rea.mjs");
  const versionPath = join(root, "installed-version");
  const npmRoot = npmReportsUserPrefix
    ? join(prefix, "lib", "node_modules")
    : join(root, "npm-default", "lib", "node_modules");
  const npmPrefix = npmReportsUserPrefix ? prefix : join(root, "npm-default");
  const npmLog = join(root, "npm-invocations.jsonl");
  const binDirectory = join(root, "bin");
  const npmRecorder = join(binDirectory, "record-npm.mjs");
  await mkdir(dirname(packageEntry), { recursive: true });
  await mkdir(join(prefix, "bin"), { recursive: true });
  await mkdir(binDirectory);
  await writeFile(versionPath, "3.2.1");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: PRODUCT_IDENTITY.packageName,
      bin: { rea: "scripts/rea.mjs" },
    }),
  );
  await writeFile(
    packageEntry,
    `import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(versionPath)}, "utf8") + "\\n");\n`,
  );
  await symlink(
    relative(join(prefix, "bin"), packageEntry),
    join(prefix, "bin", "rea"),
  );
  await writeFile(
    npmRecorder,
    [
      'import { appendFileSync, writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(args) + "\\n");`,
      `if (JSON.stringify(args) === '["root","--global"]') console.log(${JSON.stringify(npmRoot)});`,
      `else if (JSON.stringify(args) === '["prefix","--global"]') console.log(${JSON.stringify(npmPrefix)});`,
      `else if (args[0] === "view") process.stdout.write('"3.3.0"\\n');`,
      `else if (args[0] === "install") writeFileSync(${JSON.stringify(versionPath)}, "3.3.0");`,
      "else process.exitCode = 2;",
      "",
    ].join("\n"),
  );
  const executable = join(binDirectory, "npm");
  await writeFile(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(npmRecorder)} "$@"\n`,
    { mode: 0o755 },
  );
  const pathKey =
    Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
    "PATH";
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: selectedHome,
    XDG_CACHE_HOME: join(root, "cache"),
    [pathKey]: `${binDirectory}${delimiter}${process.env[pathKey] ?? ""}`,
  };
  delete environment.BUN_INSTALL;
  delete environment.BUN_INSTALL_GLOBAL_DIR;
  return {
    environment,
    npmLog,
    packageEntry,
    packageRoot,
    prefix,
    selectedHome,
    versionPath,
  };
};

describe.skipIf(process.platform === "win32")(
  "legacy Linux installer npm ownership with ambiguous scope",
  () => {
    it("honors an exact npm root despite a leftover Bun lockfile", async () => {
      const root = await createTestTempDirectory(
        "rea-linux-user-prefix-npm-proof-",
      );
      try {
        const fixture = await linuxUserPrefixFixture(root, true);
        await writeFile(join(fixture.prefix, "lib", "bun.lock"), "{}\n");
        const result = await systemUpdateHost(
          fixture.packageRoot,
          fixture.selectedHome,
          fixture.environment,
        ).installation();
        expect(result).toEqual({
          manager: "npm",
          prefix: fixture.prefix,
          packageRoot: await realpath(fixture.packageRoot),
        });
        expect(await readCommandInvocations(fixture.npmLog)).toEqual([
          ["root", "--global"],
          ["prefix", "--global"],
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "unproven custom-prefix package ownership",
  () => {
    it.each(["lockless", "bun-lock"] as const)(
      "refuses a markerless custom-prefix package (%s) without npm root proof",
      async (lockType) => {
        const root = await createTestTempDirectory(
          "rea-linux-user-prefix-bun-lock-",
        );
        try {
          const fixture = await linuxUserPrefixFixture(root);
          if (lockType === "bun-lock")
            await writeFile(join(fixture.prefix, "lib", "bun.lock"), "{}\n");
          const result = await runUpdate(
            "3.2.1",
            systemUpdateHost(
              fixture.packageRoot,
              fixture.selectedHome,
              fixture.environment,
            ),
            "structured",
          );
          expect(result).toMatchObject({
            status: "failed",
            reason: "unknown-install-method",
          });
          expect(await readFile(fixture.versionPath, "utf8")).toBe("3.2.1");
          expect(
            (await readCommandInvocations(fixture.npmLog)).some(
              (call) => Array.isArray(call) && call[0] === "install",
            ),
          ).toBe(false);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );

    it("refuses a .local link that is also exposed through an unresolved Bun ancestor", async () => {
      const root = await createTestTempDirectory(
        "rea-linux-user-prefix-bun-ancestor-",
      );
      try {
        const fixture = await linuxUserPrefixFixture(root);
        const ancestorPackage = join(
          fixture.selectedHome,
          "node_modules",
          PRODUCT_IDENTITY.packageName,
        );
        const bunGlobal = join(
          fixture.selectedHome,
          ".bun",
          "install",
          "global",
        );
        await mkdir(dirname(ancestorPackage), { recursive: true });
        await mkdir(bunGlobal, { recursive: true });
        await writeFile(join(fixture.selectedHome, "package.json"), "{}\n");
        await symlink(
          relative(dirname(ancestorPackage), fixture.packageRoot),
          ancestorPackage,
        );
        fixture.environment.BUN_INSTALL_GLOBAL_DIR = bunGlobal;
        const result = await runUpdate(
          "3.2.1",
          systemUpdateHost(
            ancestorPackage,
            fixture.selectedHome,
            fixture.environment,
          ),
          "structured",
        );
        expect(result).toMatchObject({
          status: "failed",
          reason: "unknown-install-method",
          latestVersion: null,
          remediation: expect.stringContaining("cannot prove Bun installed it"),
        });
        expect(await readCommandInvocations(fixture.npmLog)).toEqual([
          ["root", "--global"],
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

describe("Bun global installation update", () => {
  it.each([
    ["1.4.2", "updated", "absolute", UPDATE_COMMAND_OUTPUT_BYTES + 1, 0],
    ["1.4.2", "install-failed", "absolute", UPDATE_COMMAND_OUTPUT_BYTES + 1, 2],
    ["1.2.17", "updated", "absolute", 0, 0],
    ["1.2.17", "updated", "relative", 0, 0],
    ["1.2.17", "unknown", "ancestor", 0, 0],
    ["1.2.14", "failed", "absolute", 0, 0],
    ["1.2.17-canary.1", "failed", "absolute", 0, 0],
    ["unknown", "failed", "absolute", 0, 0],
  ] as const)(
    "handles Bun %s with outcome %s using %s global project",
    async (
      bunVersion,
      status,
      projectMode,
      installOutputBytes,
      installExitCode,
    ) => {
      // A recording `bun` on PATH crosses the real subprocess boundary without registry access.
      const root = await createTestTempDirectory("rea-update-bun-");
      const {
        bunInstall,
        globalDirectory,
        projectDirectory,
        packageRoot,
        versionPath,
        logPath,
        binDirectory,
      } = await createBunUpdateFixture(root, {
        bunVersion,
        installOutputBytes,
        installExitCode,
        project: projectMode === "ancestor" ? "ancestor" : "global",
      });
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
        "PATH";
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        [pathKey]: `${binDirectory}${delimiter}${process.env[pathKey] ?? ""}`,
        BUN_INSTALL: bunInstall,
      };
      delete environment.BUN_INSTALL_GLOBAL_DIR;
      if (projectMode === "relative")
        environment.BUN_INSTALL_GLOBAL_DIR = relative(root, globalDirectory);

      const callerDirectory = process.cwd();
      let result: UpdateResult;
      try {
        process.chdir(root);
        result = await runUpdate(
          "3.2.1",
          systemUpdateHost(packageRoot, home, environment),
          "structured",
        );
      } finally {
        process.chdir(callerDirectory);
      }

      const invocations = await readCommandInvocations(logPath);
      const versionInvocation = {
        args: ["--version"],
        cwd: projectDirectory,
        globalDirectory: projectDirectory,
      };
      if (status === "failed") {
        expect(result).toEqual({
          status: "failed",
          currentVersion: "3.2.1",
          latestVersion: null,
          reason: "version-check",
          remediation: `REA updates for Bun global installations require Bun 1.2.17 or later; bun --version returned ${JSON.stringify(bunVersion)}. Upgrade Bun manually, then rerun rea update.`,
        });
        expect(invocations).toEqual([versionInvocation]);
        expect(await readFile(versionPath, "utf8")).toBe("3.2.1");
        return;
      }

      if (status === "unknown") {
        expect(result).toMatchObject({
          status: "failed",
          currentVersion: "3.2.1",
          latestVersion: null,
          reason: "unknown-install-method",
          remediation: expect.stringContaining(
            "cannot prove Bun installed it. It left that project unchanged",
          ),
        });
        expect(invocations).toEqual([]);
        expect(await readFile(versionPath, "utf8")).toBe("3.2.1");
        return;
      }

      if (status === "install-failed") {
        expect(result).toMatchObject({
          status: "failed",
          reason: "install",
          remediation: expect.stringContaining("diagnostics truncated"),
        });
        expect(await readFile(versionPath, "utf8")).toBe("3.2.1");
      } else
        expect(result).toMatchObject({
          status: "updated",
          installMethod: "bun",
          installedVersion: "3.3.0",
          command: [
            "bun",
            "add",
            "--global",
            "--ignore-scripts",
            `${PRODUCT_IDENTITY.packageName}@3.3.0`,
          ],
        });
      // `bun info` needs a project in its working directory, and neither the
      // caller's directory nor a later ancestor search may select another
      // project, so all commands run in the owner pinned as the global directory.
      expect(invocations).toEqual([
        versionInvocation,
        {
          args: [
            "info",
            PRODUCT_IDENTITY.packageName,
            "dist-tags.latest",
            "--json",
          ],
          cwd: projectDirectory,
          globalDirectory: projectDirectory,
        },
        {
          args: [
            "add",
            "--global",
            "--ignore-scripts",
            `${PRODUCT_IDENTITY.packageName}@3.3.0`,
          ],
          cwd: projectDirectory,
          globalDirectory: projectDirectory,
        },
      ]);
    },
  );
});

describe("verified npm ownership in a Bun ancestor project", () => {
  it("updates the npm-owned package without invoking Bun", async () => {
    const root = await createTestTempDirectory("rea-update-npm-bun-ancestor-");
    const projectDirectory = join(root, "home");
    const bunInstall = join(projectDirectory, ".bun");
    const packageRoot = join(
      projectDirectory,
      "node_modules",
      PRODUCT_IDENTITY.packageName,
    );
    const versionPath = join(root, "installed-version");
    const npmLog = join(root, "npm-invocations.jsonl");
    const bunLog = join(root, "bun-invocations.jsonl");
    const binDirectory = join(root, "bin");
    const npmRecorder = join(binDirectory, "record-npm.mjs");
    const bunRecorder = join(binDirectory, "record-bun.mjs");
    await mkdir(join(packageRoot, "scripts"), { recursive: true });
    await mkdir(join(bunInstall, "install", "global"), { recursive: true });
    await mkdir(binDirectory);
    await writeFile(join(projectDirectory, "package.json"), "{}\n");
    await writeFile(versionPath, "3.2.1");
    await writeFile(
      join(packageRoot, "scripts", "rea.mjs"),
      `import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(versionPath)}, "utf8") + "\\n");\n`,
    );
    await writeFile(
      npmRecorder,
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(args) + "\\n");`,
        `if (JSON.stringify(args) === '["root","--global"]') console.log(${JSON.stringify(join(projectDirectory, "node_modules"))});`,
        `else if (JSON.stringify(args) === '["prefix","--global"]') console.log(${JSON.stringify(projectDirectory)});`,
        `else if (args[0] === "view") process.stdout.write('"3.3.0"\\n');`,
        `else if (args[0] === "install") writeFileSync(${JSON.stringify(versionPath)}, "3.3.0");`,
        "else process.exitCode = 2;",
        "",
      ].join("\n"),
    );
    await writeFile(
      bunRecorder,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(bunLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exitCode = 2;\n`,
    );
    if (process.platform === "win32") {
      await writeFile(
        join(binDirectory, "npm.cmd"),
        `@"${process.execPath}" "${npmRecorder}" %*\r\n`,
      );
      await writeFile(
        join(binDirectory, "bun.cmd"),
        `@"${process.execPath}" "${bunRecorder}" %*\r\n`,
      );
    } else {
      await writeFile(
        join(binDirectory, "npm"),
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(npmRecorder)} "$@"\n`,
        { mode: 0o755 },
      );
      await writeFile(
        join(binDirectory, "bun"),
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(bunRecorder)} "$@"\n`,
        { mode: 0o755 },
      );
    }
    const pathKey =
      Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
      "PATH";
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      [pathKey]: `${binDirectory}${delimiter}${process.env[pathKey] ?? ""}`,
      BUN_INSTALL: bunInstall,
    };
    delete environment.BUN_INSTALL_GLOBAL_DIR;

    const callerDirectory = process.cwd();
    try {
      process.chdir(root);
      await symlink(".local", join(projectDirectory, ".local"));
      const result = await runUpdate(
        "3.2.1",
        systemUpdateHost(packageRoot, projectDirectory, environment),
        "structured",
      );
      expect(result).toMatchObject({
        status: "updated",
        installMethod: "npm",
        installedVersion: "3.3.0",
      });
      expect(await readFile(versionPath, "utf8")).toBe("3.3.0");
      const npmCalls = await readCommandInvocations(npmLog);
      expect(npmCalls).toContainEqual(["root", "--global"]);
      expect(npmCalls).toContainEqual(["prefix", "--global"]);
      expect(npmCalls).toContainEqual(
        expect.arrayContaining(["install", "--global", "--ignore-scripts"]),
      );
      await expect(readFile(bunLog, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.chdir(callerDirectory);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("unverified npm path shapes in a Bun ancestor project", () => {
  it("refuses a lib/node_modules path when npm reports another global root", async () => {
    const root = await createTestTempDirectory(
      "rea-update-unverified-npm-shape-",
    );
    const projectDirectory = join(root, "tools", "lib");
    const globalDirectory = join(projectDirectory, "bun-global");
    const packageRoot = join(
      projectDirectory,
      "node_modules",
      PRODUCT_IDENTITY.packageName,
    );
    const npmRoot = join(root, "unrelated-npm-root", "node_modules");
    const npmLog = join(root, "npm-invocations.jsonl");
    const bunLog = join(root, "bun-invocations.jsonl");
    const binDirectory = join(root, "bin");
    const npmRecorder = join(binDirectory, "record-npm.mjs");
    const bunRecorder = join(binDirectory, "record-bun.mjs");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(globalDirectory, { recursive: true });
    await mkdir(binDirectory);
    await writeFile(join(projectDirectory, "package.json"), "{}\n");
    await writeFile(
      npmRecorder,
      [
        'import { appendFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(args) + "\\n");`,
        `if (JSON.stringify(args) === '["root","--global"]') console.log(${JSON.stringify(npmRoot)});`,
        `else if (JSON.stringify(args) === '["prefix","--global"]') console.log(${JSON.stringify(root)});`,
        `else if (args[0] === "view") process.stdout.write('"3.3.0"\\n');`,
        "else process.exitCode = 2;",
        "",
      ].join("\n"),
    );
    await writeFile(
      bunRecorder,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(bunLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exitCode = 2;\n`,
    );
    if (process.platform === "win32") {
      await writeFile(
        join(binDirectory, "npm.cmd"),
        `@"${process.execPath}" "${npmRecorder}" %*\r\n`,
      );
      await writeFile(
        join(binDirectory, "bun.cmd"),
        `@"${process.execPath}" "${bunRecorder}" %*\r\n`,
      );
    } else {
      await writeFile(
        join(binDirectory, "npm"),
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(npmRecorder)} "$@"\n`,
        { mode: 0o755 },
      );
      await writeFile(
        join(binDirectory, "bun"),
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(bunRecorder)} "$@"\n`,
        { mode: 0o755 },
      );
    }
    const pathKey =
      Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
      "PATH";
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      [pathKey]: `${binDirectory}${delimiter}${process.env[pathKey] ?? ""}`,
      BUN_INSTALL_GLOBAL_DIR: globalDirectory,
    };
    delete environment.BUN_INSTALL;

    const callerDirectory = process.cwd();
    try {
      process.chdir(root);
      const result = await runUpdate(
        "3.2.1",
        systemUpdateHost(packageRoot, projectDirectory, environment),
        "structured",
      );
      expect(result).toMatchObject({
        status: "failed",
        reason: "unknown-install-method",
        latestVersion: null,
        remediation: expect.stringContaining(
          "cannot prove Bun installed it. It left that project unchanged",
        ),
      });
      expect(await readCommandInvocations(npmLog)).toEqual([
        ["root", "--global"],
      ]);
      await expect(readFile(bunLog, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.chdir(callerDirectory);
      await rm(root, { recursive: true, force: true });
    }
  });
});
