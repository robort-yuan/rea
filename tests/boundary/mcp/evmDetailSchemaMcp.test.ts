import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { EvmInterfaceService } from "../../../src/application/evm/EvmInterfaceService.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

it("advertises the shared EVM detail guidance and default", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("binary provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    {
      evmInterface: new EvmInterfaceService({
        inspect: async () => {
          throw new Error("EVM provider must not run during discovery");
        },
      }),
    },
  );
  const client = new Client({ name: "evm-detail-schema", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tool = (await client.listTools()).tools.find(
    (candidate) => candidate.name === "inspect_evm_interface",
  );
  if (tool === undefined) throw new Error("Missing inspect_evm_interface tool");

  const properties = tool.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const detail = properties?.detail;
  expect(detail).toMatchObject({
    type: "string",
    enum: ["complete", "summary"],
    default: "complete",
  });
  expect(detail?.description).toContain(
    "summary retains that complete Evidence",
  );
});
