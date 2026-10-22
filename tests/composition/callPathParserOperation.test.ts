import { expect, it } from "vitest";
import { z } from "zod";

import { createAnalysisExecution } from "../../src/application/AnalysisProvider.js";
import { traceCallPath } from "../../src/application/CallPathTracing.js";
import { ok } from "../../src/domain/result.js";

it("attributes malformed relationship output to the originating provider operation", async () => {
  const result = await traceCallPath(
    async (operation) =>
      ok(operation === "procedure_address" ? "0x1000" : "0x1000"),
    async () =>
      ok(
        createAnalysisExecution(
          { callees: [123] },
          { id: "test", name: "test", version: null },
        ),
      ),
    { start: "entry", direction: "forward" },
  );

  expect(result.ok).toBe(true);
  if (result.ok) {
    const failures = z
      .object({
        failures: z.array(
          z.object({
            error: z.object({
              details: z.object({ operation: z.string() }),
            }),
          }),
        ),
      })
      .parse(result.value).failures;
    expect(failures[0]?.error.details.operation).toBe("procedure_callees");
  }
});

it.each([false, true])(
  "traces a long chain with goal requested: %s",
  async (withGoal) => {
    const nodeCount = 16_384;
    const addresses = Array.from(
      { length: nodeCount },
      (_, index) => `0x${index.toString(16).padStart(5, "0")}`,
    );
    const addressIndices = new Map(
      addresses.map((address, index) => [address, index]),
    );
    const provider = { id: "test", name: "test", version: null };

    const result = await traceCallPath(
      async (_operation, arguments_) => ok(String(arguments_.procedure)),
      async (_operation, arguments_) => {
        const address = String(arguments_.procedure);
        const index = addressIndices.get(address) ?? -1;
        const next = index >= 0 ? addresses[index + 1] : undefined;
        return ok(
          createAnalysisExecution(
            { callees: next === undefined ? [] : [next] },
            provider,
            { relationshipCoverage: { status: "complete" } },
          ),
        );
      },
      {
        start: addresses[0]!,
        ...(withGoal ? { goal: addresses.at(-1)! } : {}),
        direction: "forward",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        traversal: { nodes_visited: nodeCount },
        traversal_path: withGoal ? addresses : [],
        goal_status: withGoal ? "reached" : "not_requested",
      },
    });
  },
);

it.each(["forward", "backward"] as const)(
  "reconstructs the first shortest %s path through cycles and duplicate relationships",
  async (direction) => {
    const relationships: Readonly<Record<string, readonly string[]>> = {
      "0x1": ["0x3", "0x1", "0x2", "0x2"],
      "0x2": ["0x4", "0x1"],
      "0x3": ["0x5", "0x4"],
      "0x4": ["0x6"],
    };
    const calls: string[] = [];
    const result = await traceCallPath(
      async (_operation, arguments_) => ok(String(arguments_.procedure)),
      async (operation, arguments_) => {
        const address = String(arguments_.procedure);
        calls.push(address);
        expect(operation).toBe(
          direction === "forward" ? "procedure_callees" : "procedure_callers",
        );
        return ok(
          createAnalysisExecution(
            {
              [direction === "forward" ? "callees" : "callers"]:
                relationships[address] ?? [],
            },
            { id: "test", name: "test", version: null },
            { relationshipCoverage: { status: "complete" } },
          ),
        );
      },
      { start: "0x1", goal: "0x6", direction },
    );

    expect(calls).toEqual(["0x1", "0x2", "0x3", "0x4"]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        traversal_path: ["0x1", "0x2", "0x4", "0x6"],
        nodes: [
          { address: "0x1", depth: 0 },
          { address: "0x2", depth: 1 },
          { address: "0x3", depth: 1 },
          { address: "0x4", depth: 2 },
          { address: "0x5", depth: 2 },
          { address: "0x6", depth: 3 },
        ],
        goal_status: "reached",
        truncated: false,
      },
    });
  },
);
