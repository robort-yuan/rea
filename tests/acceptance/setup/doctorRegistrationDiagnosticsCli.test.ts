import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const cases = [
  {
    client: "cursor",
    path: ".cursor/mcp.json",
    document: { mcpServers: { rea: { command: 42 } } },
    field: "command",
  },
  {
    client: "cursor",
    path: ".cursor/mcp.json",
    document: { mcpServers: { rea: { command: "rea", args: ["mcp", 42] } } },
    field: "args.1",
  },
  {
    client: "opencode",
    path: ".config/opencode/opencode.json",
    document: { mcp: { rea: { type: "remote", command: ["rea", "mcp"] } } },
    field: "type",
  },
  {
    client: "commandcode",
    path: ".commandcode/mcp.json",
    document: { mcpServers: { rea: { command: "rea", transport: "sse" } } },
    field: "transport",
  },
  {
    client: "cursor",
    path: ".cursor/mcp.json",
    document: { mcpServers: { rea: null } },
    field: "rea",
  },
] as const;

for (const scenario of cases)
  cliTest(
    `doctor explains invalid ${scenario.client} registration ${scenario.field}`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-doctor-registration-");
      const configPath = join(home, scenario.path);
      await mkdir(dirname(configPath), { recursive: true });
      const original = JSON.stringify(scenario.document);
      await writeFile(configPath, original);

      const result = await cli.run({
        arguments: ["doctor", "--client", scenario.client, "--json"],
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
        },
      });

      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        healthy: false,
        scope: { mode: "explicit", clients: [scenario.client] },
        scope_checks: expect.arrayContaining([
          expect.objectContaining({
            name: `registration:${scenario.client}`,
            ok: false,
            detail: configPath,
            remediation: expect.stringContaining(`${scenario.field}:`),
          }),
        ]),
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client: scenario.client,
              config_path: configPath,
              state: "invalid",
              command: [],
              remediation: expect.stringContaining(
                "Invalid REA server registration",
              ),
            }),
          ]),
        },
      });
      expect(result.stdout).toContain("rea setup");
      expect(result.stdout).not.toContain("invalid_type");
      expect(await readFile(configPath, "utf8")).toBe(original);
      expect(await readdir(dirname(configPath))).toEqual([
        scenario.path.split("/").at(-1),
      ]);
    },
  );
