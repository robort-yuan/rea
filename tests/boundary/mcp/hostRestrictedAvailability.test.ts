import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";

import {
  expandToolAvailability,
  sessionProvider,
} from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const linux = process.platform === "linux";
const linuxX64 = linux && process.arch === "x64";

/** Each tool with whether its execution guard admits this host. */
const HOST_RESTRICTED_TOOLS = [
  ["inspect_packet_capture", linux],
  ["inspect_packet_fields", linux],
  ["decode_signal_recording", linux],
  ["inspect_signal_decoders", linux],
  ["inspect_firmware_regions", linux],
  ["extract_firmware", linux],
  ["inspect_binary_layout", linuxX64],
  ["inspect_recorded_crash", linuxX64],
  ["recover_javascript_sources", linuxX64],
  ["inspect_evm_interface", linuxX64],
] as const;

it("reports host-restricted integrations by host before their configuration", async () => {
  const directory = await createTestTempDirectory("rea-host-restricted-mcp-");
  const tool = (name: string) => join(directory, name);
  const session = createTestBinarySession(() => {
    throw new Error("binary analysis must not start during status discovery");
  });
  // Absolute paths configure every integration; discovery does not run them.
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        REA_TSHARK_COMMAND: tool("tshark"),
        REA_SIGROK_COMMAND: tool("sigrok-cli"),
        REA_BINWALK_COMMAND: tool("binwalk"),
        REA_UNBLOB_COMMAND: tool("unblob"),
        REA_PWNTOOLS_PYTHON: tool("python3"),
        REA_WAKARU_COMMAND: tool("wakaru"),
        REA_EVM_PRLIMIT_COMMAND: tool("missing-prlimit"),
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      },
    },
  );
  const client = new Client({
    name: "host-restricted-availability",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(response.isError).not.toBe(true);
    const availability = expandToolAvailability(
      z.object({ result: sessionProvider }).parse(response.structuredContent)
        .result.tool_availability,
    );
    for (const [name, hostSupported] of HOST_RESTRICTED_TOOLS) {
      const entry = availability.find((candidate) => candidate.name === name);
      if (!hostSupported)
        expect(entry, name).toMatchObject({
          available: false,
          reason: "unsupported_host",
        });
      else if (name === "inspect_evm_interface")
        // The configured limiter is absent; the host itself is supported.
        expect(entry, name).toMatchObject({
          available: false,
          reason: "provider_missing",
        });
      else expect(entry, name).toMatchObject({ available: true });
    }
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});
