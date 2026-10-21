import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import type { BinaryLayoutPort } from "../../../src/application/binaryDiagnostics/BinaryLayoutPort.js";
import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { analysisViewLayoutFixture } from "../../fixtures/analysisView.js";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import { BINARY_LAYOUT_TEST_PROVIDER } from "../../fixtures/binaryDiagnostics/layout.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const contract = toolContract("analyze_javascript_application");

const connect = async (
  retainsEvidence: boolean,
  binaryLayout?: BinaryLayoutService,
) => {
  const session = createTestBinarySession(() => {
    throw new Error("JavaScript analysis must not start a deep provider");
  });
  const server = createServer(
    retainsEvidence
      ? { kind: "session", session }
      : {
          kind: "fixed",
          analysis: {
            execute: () => {
              throw new Error("JavaScript analysis must not use a target");
            },
          },
        },
    binaryLayout === undefined ? {} : { binaryLayout },
  );
  const client = new Client({ name: "analysis-summary-detail", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const application = async () => {
  const root = await createTestTempDirectory("rea-summary-detail-");
  await writeFile(
    join(root, "main.js"),
    'import { helper } from "./util.js";\nexport const greet = (name) => helper(name);\n',
  );
  await writeFile(
    join(root, "util.js"),
    "export const helper = (value) => value.toUpperCase();\n",
  );
  return { input_path: root, format: "directory" };
};

const textBytes = (content: unknown): number => {
  const [first] = Array.isArray(content) ? content : [];
  if (first?.type !== "text") throw new Error("Missing MCP text result");
  return Buffer.byteLength(String(first.text));
};

it("returns the summary of complete Evidence retained for later views", async () => {
  const client = await connect(true);
  const input = await application();
  const complete = await client.callTool({
    name: contract.name,
    arguments: input,
  });
  expect(complete.isError).not.toBe(true);
  const completeEvidence = contract.outputSchema.parse(
    complete.structuredContent,
  );
  expect(completeEvidence.operation).toBe("analyze_javascript_application");

  const summary = await client.callTool({
    name: contract.name,
    arguments: { ...input, detail: "summary" },
  });
  expect(summary.isError).not.toBe(true);
  const summaryEvidence = contract.outputSchema.parse(
    summary.structuredContent,
  );
  expect(summaryEvidence).toMatchObject({
    operation: "inspect_analysis_view",
    evidence_links: [completeEvidence.evidence_id],
    normalized_result: {
      kind: "summary",
      parent_evidence_id: completeEvidence.evidence_id,
      parent_operation: "analyze_javascript_application",
    },
  });
  expect(textBytes(summary.content)).toBeLessThan(textBytes(complete.content));

  const modules = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: completeEvidence.evidence_id,
      },
      view: { kind: "page", collection: "modules", offset: 0, limit: 8 },
    },
  });
  expect(modules.isError).not.toBe(true);
  expect(modules.structuredContent).toMatchObject({
    normalized_result: {
      kind: "page",
      parent_evidence_id: completeEvidence.evidence_id,
    },
  });
});

it("refuses JavaScript summary delivery before analysis starts when retention is unavailable and keeps fixed-server complete delivery", async () => {
  const client = await connect(false);
  const input = await application();
  // Analysis reports its first phase before reading any artifact, so a
  // progress-observed request shows whether analysis started at all.
  const progress: string[] = [];
  const onprogress = (update: { readonly message?: string | undefined }) => {
    progress.push(update.message ?? "");
  };
  const summaryInput = { ...input, detail: "summary" };
  const refused = parseMcpToolError(
    await client.callTool(
      { name: contract.name, arguments: summaryInput },
      { onprogress },
    ),
  );
  expect(refused.error).toMatchObject({
    code: "capability_unavailable",
    message: expect.stringContaining("does not retain Evidence"),
  });
  expect(progress).toEqual([]);
  for (const complete of [input, { ...input, detail: "complete" }]) {
    const response = await client.callTool(
      { name: contract.name, arguments: complete },
      { onprogress },
    );
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(
      contract.outputSchema.parse(response.structuredContent),
    ).toMatchObject({
      operation: "analyze_javascript_application",
      parameters: { input_path: input.input_path },
    });
  }
  expect(progress[0]).toMatch(/^analyze_javascript_application: /);
  const observed = progress.length;
  const archive = join(input.input_path, "broken.asar");
  await writeFile(archive, asarHeaderBytes("not json"));
  const failing = { input_path: archive };
  const failure = parseMcpToolError(
    await client.callTool({ name: contract.name, arguments: failing }),
  );
  expect(failure.error).toMatchObject({
    code: "artifact_operation_failed",
    details: { reason: "format" },
  });
  const stillRefused = parseMcpToolError(
    await client.callTool(
      { name: contract.name, arguments: { ...failing, detail: "summary" } },
      { onprogress },
    ),
  );
  expect(stillRefused.error).toMatchObject({
    code: "capability_unavailable",
    message: expect.stringContaining("Select detail complete"),
  });
  expect(progress).toHaveLength(observed);
});

it("returns the summary of retained binary layout Evidence", async () => {
  const layout = analysisViewLayoutFixture();
  const client = await connect(
    true,
    new BinaryLayoutService({
      inspectAndClose(input, options) {
        return this.inspect(input, options);
      },
      identity: BINARY_LAYOUT_TEST_PROVIDER,
      inspect: () => Promise.resolve(ok(layout)),
    }),
  );
  const layoutContract = toolContract("inspect_binary_layout");
  const summary = await client.callTool({
    name: layoutContract.name,
    arguments: { path: layout.artifact.path, detail: "summary" },
  });
  expect(summary.isError).not.toBe(true);
  const evidence = layoutContract.outputSchema.parse(summary.structuredContent);
  expect(evidence).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "inspect_binary_layout",
    },
  });
  const [parentId] = evidence.evidence_links;
  const sections = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parentId },
      view: { kind: "page", collection: "sections", offset: 0, limit: 8 },
    },
  });
  expect(sections.isError).not.toBe(true);
  expect(sections.structuredContent).toMatchObject({
    normalized_result: { kind: "page", parent_evidence_id: parentId },
  });
});

it("rejects malformed layout paths, refuses layout summary delivery before provider work when retention is unavailable, and keeps fixed-server complete delivery", async () => {
  const layout = analysisViewLayoutFixture();
  const inspect = vi.fn<BinaryLayoutPort["inspect"]>(() =>
    Promise.resolve(ok(layout)),
  );
  const client = await connect(
    false,
    new BinaryLayoutService({
      inspectAndClose(input, options) {
        return this.inspect(input, options);
      },
      identity: BINARY_LAYOUT_TEST_PROVIDER,
      inspect,
    }),
  );
  const layoutContract = toolContract("inspect_binary_layout");
  const summaryInput = { path: layout.artifact.path, detail: "summary" };
  const refused = parseMcpToolError(
    await client.callTool({
      name: layoutContract.name,
      arguments: summaryInput,
    }),
  );
  expect(refused.error).toMatchObject({
    code: "capability_unavailable",
    message: expect.stringContaining("does not retain Evidence"),
  });
  expect(inspect).not.toHaveBeenCalled();
  const malformed = parseMcpToolError(
    await client.callTool({
      name: layoutContract.name,
      arguments: { path: "relative.elf", detail: "summary" },
    }),
  );
  expect(malformed.error).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["path"],
          reason: "invalid_format",
          message: "Expected an absolute filesystem path on this host.",
        },
      ],
    },
  });
  expect(inspect).not.toHaveBeenCalled();
  for (const complete of [
    { path: layout.artifact.path },
    { path: layout.artifact.path, detail: "complete" },
  ]) {
    const response = await client.callTool({
      name: layoutContract.name,
      arguments: complete,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = layoutContract.outputSchema.parse(
      response.structuredContent,
    );
    expect(evidence.operation).toBe("inspect_binary_layout");
    expect(evidence.normalized_result).toEqual(layout);
  }
  expect(inspect).toHaveBeenCalledTimes(2);
  inspect.mockImplementation(() =>
    Promise.resolve(err(new AnalysisInputError("inspect_binary_layout"))),
  );
  const stillRefused = parseMcpToolError(
    await client.callTool({
      name: layoutContract.name,
      arguments: summaryInput,
    }),
  );
  expect(stillRefused.error).toMatchObject({
    code: "capability_unavailable",
    message: expect.stringContaining("Select detail complete"),
  });
  expect(inspect).toHaveBeenCalledTimes(2);
});
