import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseClientConfiguration } from "../../../src/application/ClientConfigurationDocument.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  clearClientLocationEnvironment,
  NPX_REGISTRATION_COMMAND,
} from "../../fixtures/clientEnvironment.js";

const command = NPX_REGISTRATION_COMMAND;

beforeEach(clearClientLocationEnvironment);

afterEach(() => vi.unstubAllEnvs());

const futureClient = (
  home: string,
  environment: Readonly<NodeJS.ProcessEnv> = {},
): ReturnType<typeof supportedClients>[number] => {
  const client = supportedClients(home, "darwin", environment).find(
    ({ name }) => name === "future",
  );
  if (client === undefined) throw new Error("missing FutureOS client");
  return client;
};

const registrationOf = async (
  path: string,
): Promise<Record<string, unknown>> => {
  const document = JSON.parse(await readFile(path, "utf8")) as {
    readonly servers: Readonly<Record<string, Record<string, unknown>>>;
  };
  const registration = document.servers[PRODUCT_IDENTITY.mcpServerKey];
  if (registration === undefined) throw new Error("missing rea registration");
  return registration;
};

describe("FutureOS client configuration", () => {
  it("resolves the home root and ignores a relative FUTURE_HOME", () => {
    expect(futureClient("/home/user").configPath).toBe(
      "/home/user/.future/mcp.json",
    );
    // Empty and relative overrides are ignored by FutureOS itself, so setup
    // must not resolve them into a file the client never reads.
    expect(futureClient("/home/user", { FUTURE_HOME: "" }).configPath).toBe(
      "/home/user/.future/mcp.json",
    );
    expect(futureClient("/home/user", { FUTURE_HOME: "rel" }).configPath).toBe(
      "/home/user/.future/mcp.json",
    );
    expect(
      futureClient("/home/user", { FUTURE_HOME: "~/other" }).configPath,
    ).toBe("/home/user/.future/mcp.json");
    expect(
      futureClient("/home/user", { FUTURE_HOME: "/opt/futureos" }).configPath,
    ).toBe("/opt/futureos/mcp.json");
  });

  it("writes only the fields FutureOS accepts, then reads and removes the entry", async () => {
    const home = await createTestTempDirectory("rea-future-client-");
    const client = futureClient(home);
    await mkdir(client.markerPath ?? home, { recursive: true });

    const configured = await configureClientConfiguration(client, {}, command);
    expect(configured.status).toBe("configured");
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });

    // FutureOS denies unknown fields on both McpConfig and ServerSpec, so the
    // entry may carry no `type` discriminator and no other extra key.
    expect(await registrationOf(client.configPath)).toEqual({
      command: command[0],
      args: command.slice(1),
      enabled: true,
    });

    const statuses = await readClientRegistrationStatuses(home);
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "future",
          state: "aligned",
          command: [...command],
        }),
      ]),
    );

    const removed = await systemUninstallHost(home).removeClient(client);
    expect(removed.status).toBe("removed");
    const document = JSON.parse(await readFile(client.configPath, "utf8")) as {
      readonly servers: Readonly<Record<string, unknown>>;
    };
    expect(document.servers[PRODUCT_IDENTITY.mcpServerKey]).toBeUndefined();
  });

  it("preserves other servers and the working directory across a refresh", async () => {
    const home = await createTestTempDirectory("rea-future-preserve-");
    const client = futureClient(home);
    await mkdir(client.markerPath ?? home, { recursive: true });
    const existing = { command: "node", args: ["other.js"], enabled: false };
    await writeFile(
      client.configPath,
      JSON.stringify({
        servers: {
          other: existing,
          [PRODUCT_IDENTITY.mcpServerKey]: {
            command: "/old/rea",
            args: ["mcp"],
            cwd: "/srv/targets",
            enabled: true,
          },
        },
      }),
    );

    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "configured" });
    const document = JSON.parse(await readFile(client.configPath, "utf8")) as {
      readonly servers: Readonly<Record<string, Record<string, unknown>>>;
    };
    expect(document.servers.other).toEqual(existing);
    expect(document.servers[PRODUCT_IDENTITY.mcpServerKey]).toEqual({
      command: command[0],
      args: command.slice(1),
      cwd: "/srv/targets",
      enabled: true,
    });
  });

  it("reports a stale registration for a disabled entry and re-enables it", async () => {
    const home = await createTestTempDirectory("rea-future-disabled-");
    const client = futureClient(home);
    await mkdir(client.markerPath ?? home, { recursive: true });
    await writeFile(
      client.configPath,
      JSON.stringify({
        servers: {
          [PRODUCT_IDENTITY.mcpServerKey]: {
            command: command[0],
            args: command.slice(1),
            enabled: false,
          },
        },
      }),
    );

    expect(await readClientRegistrationStatuses(home)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client: "future", state: "stale" }),
      ]),
    );
    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "configured" });
    expect(await registrationOf(client.configPath)).toEqual({
      command: command[0],
      args: command.slice(1),
      enabled: true,
    });
  });

  it.each([
    ["a comment", '{\n  // keep\n  "servers": {}\n}\n'],
    ["a trailing comma", '{"servers": {},}\n'],
    ["a UTF-8 BOM", '\uFEFF{"servers": {}}\n'],
  ])("rejects %s that FutureOS cannot load", (_label, text) => {
    expect(() => parseClientConfiguration(text, "future")).toThrow(SyntaxError);
  });

  it.each([
    ["an unknown top-level field", { servers: {}, extra: 1 }],
    [
      "an unknown server field",
      { servers: { others: { command: "x", type: "stdio" } } },
    ],
  ])("rejects %s", (_label, document) => {
    expect(() =>
      parseClientConfiguration(JSON.stringify(document), "future"),
    ).toThrow(TypeError);
  });

  it("detects the client from its home marker", async () => {
    const home = await createTestTempDirectory("rea-future-detect-");
    await mkdir(join(home, ".future"), { recursive: true });

    expect(
      (await detectClients(home, "darwin", {})).map(({ name }) => name),
    ).toContain("future");
  });
});

describe("FutureOS configuration dialect", () => {
  it("treats an empty file as the state before the first server", async () => {
    const home = await createTestTempDirectory("rea-future-empty-");
    const client = futureClient(home);
    await mkdir(client.markerPath ?? home, { recursive: true });
    await writeFile(client.configPath, "");

    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "configured" });
    expect(await registrationOf(client.configPath)).toEqual({
      command: command[0],
      args: command.slice(1),
      enabled: true,
    });
  });

  it("accepts an entry carrying every documented field", () => {
    const parsed = parseClientConfiguration(
      JSON.stringify({
        servers: {
          rea: {
            command: "rea",
            args: ["mcp"],
            env: { REA_CACHE: "/tmp" },
            cwd: "/srv",
            enabled: true,
          },
        },
      }),
      "future",
    );

    expect(parsed.serversPath).toEqual(["servers"]);
    expect(parsed.dialect).toBe("future");
  });
});
