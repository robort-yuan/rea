import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";

import {
  closeEnhancedToolResources,
  connect,
  inventory,
  jsonResult,
} from "./enhancedToolsHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

afterEach(closeEnhancedToolResources);

describe("enhanced MCP tools", () => {
  it("returns stable unresolved-name results", async () => {
    const tools = new EnhancedTools({
      execute: () => Promise.resolve(ok(inventory({}))),
    });

    const unresolved = await tools.execute("find_xrefs_to_name", {
      name: "missing",
    });

    expect(unresolved).toEqual({
      ok: true,
      value: {
        status: "unresolved",
        name: "missing",
        reason: "name_not_found",
      },
    });
  });

  it("returns a typed ambiguity error instead of selecting the first address", async () => {
    for (const addresses of [
      ["0x1000", "0x2000"],
      ["0x2000", "0x1000"],
    ]) {
      const xrefCalls: unknown[] = [];
      const analysis: AnalysisOperationPort = {
        execute: async (operation, parameters) => {
          if (operation === "list_names")
            return ok(
              addresses.map((address) => ({
                address,
                value: "shared_symbol",
              })),
            );
          if (operation === "xrefs") {
            xrefCalls.push((parameters as { address: string }).address);
            return ok([]);
          }
          throw new Error(`unexpected operation ${operation}`);
        },
      };
      const client = await connect(analysis);
      const reply = await client.callTool({
        name: "find_xrefs_to_name",
        arguments: { name: "shared_symbol" },
      });
      expect(reply.isError).toBe(true);
      const parsed = parseMcpToolError(reply);
      const text = JSON.stringify(parsed);
      expect(text).toContain("ambiguous");
      expect(text).toContain("0x1000");
      expect(text).toContain("0x2000");
      expect(parsed.error.recovery).toEqual({
        kind: "inspect_input_contract",
        operation: "xrefs",
      });
      expect(parsed.error.details).toMatchObject({
        operation: "xrefs",
        issues: [{ path: ["address"], reason: "invalid_value" }],
      });
      expect(xrefCalls).toEqual([]);
    }
  });

  it("keeps resolving duplicate rows at one address", async () => {
    const tools = new EnhancedTools({
      execute: async (operation) =>
        ok(
          operation === "list_names"
            ? [
                { address: "0x1000", value: "dup" },
                { address: "0x1000", value: "dup" },
              ]
            : [],
        ),
    });

    const result = await tools.execute("find_xrefs_to_name", {
      name: "dup",
    });

    expect(result).toEqual({
      ok: true,
      value: { status: "resolved", name: "dup", address: "0x1000", xrefs: [] },
    });
  });

  it("uses every procedure in one complete inventory", async () => {
    const client = await connect({
      execute: () => {
        return Promise.resolve(
          ok([
            { address: "0x1", value: "_TtC5First" },
            { address: "0x2", value: "_TtC4Last" },
          ]),
        );
      },
    });
    const result = jsonResult(
      await client.callTool({ name: "analyze_swift_types", arguments: {} }),
    );
    expect(result).toMatchObject({
      total: 2,
      categories: { classes: { count: 2 } },
    });
  });

  it("returns cancellation when a complete inventory call is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const analysis: AnalysisOperationPort = {
      execute: () => {
        calls += 1;
        controller.abort();
        return Promise.resolve(ok([{ address: "0x1", value: "_TtC5First" }]));
      },
    };

    const result = await new EnhancedTools(analysis).execute(
      "analyze_swift_types",
      {},
      controller.signal,
    );

    expect(calls).toBe(1);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });
});
