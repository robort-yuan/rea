import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import type { Client } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { artifactMcpCall } from "../../../scripts/lib/artifact-e2e.mjs";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import {
  accountFullyObservedProcessCapture,
  emptyUnverifiedProcessCapture,
} from "../../../src/domain/process/processCapture.fixture.js";
import { PROCESS_PROVIDER } from "../../../src/domain/process/processEvidenceProvider.js";
import { staticRuntimeCorrelationResultSchema } from "../../../src/domain/staticRuntimeCorrelation.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
) => {
  const response = await artifactMcpCall(client, { name, arguments: args });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  return response.structuredContent;
};

const observeAsar = async (
  client: Client,
  root: string,
  fixture: { name: string; content: string; replacement?: string },
) => {
  const { name, content, replacement } = fixture;
  const source = join(root, name);
  await mkdir(source);
  await writeFile(join(source, "main.js"), content);
  const archive = join(root, `${name}.asar`);
  await createPackageWithOptions(source, archive, {});
  if (replacement !== undefined) {
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(content));
    const bytes = await readFile(archive);
    const offset = bytes.indexOf(content);
    expect(offset).toBeGreaterThanOrEqual(0);
    bytes.write(replacement, offset, "utf8");
    await writeFile(archive, bytes);
  }
  await call(client, "open_binary", { path: archive });
  const evidence = parseEvidence(
    await call(client, "inspect_artifact", {
      integrity_policy: "record-and-continue",
    }),
  );
  const inspected = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );
  const member =
    inspected.substeps[0]?.evidence.normalized_result.occurrences.find(
      ({ logical_path }) => logical_path === "main.js",
    );
  if (member === undefined)
    throw new Error("Fixture inventory omitted main.js");
  return { evidence, member };
};

// Canonical retained captures exercise the consumer without executing a target.
const capture = (data: string) =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: { fixture: data },
    result: jsonValueSchema.parse(
      accountFullyObservedProcessCapture({
        ...emptyUnverifiedProcessCapture(),
        frames: [{ sequence: 0, at_ms: 0, data }],
      }),
    ),
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: "fixture",
      platform: "fixture",
      architecture: "fixture",
      isolation: "process",
    },
  });

it("keeps real ASAR integrity contradictions unresolved through MCP without losing genuine cochange", async () => {
  const root = await createTestTempDirectory("rea-correlation-asar-");
  const session = createTestBinarySession(new ArtifactProvider({}));
  const { client, close } = await createApplicationMcpHarness({ session });
  onTestFinished(close);
  const original = "console.log('ok');\n";
  const modified = "console.log('no');\n";
  const stale = await observeAsar(client, root, {
    name: "stale",
    content: original,
    replacement: modified,
  });
  const verified = await observeAsar(client, root, {
    name: "verified",
    content: modified,
  });
  const control = await observeAsar(client, root, {
    name: "control",
    content: original,
  });
  expect(
    [stale, verified, control].map(({ member }) => member.hash_status),
  ).toEqual(["mismatched", "verified", "verified"]);
  expect(stale.member.artifact_id).toBe(verified.member.artifact_id);
  const contradicted = parseEvidence(
    await call(client, "compare_artifacts", {
      left: stale.evidence,
      right: verified.evidence,
    }),
  );
  expect(contradicted.normalized_result).toMatchObject({
    changes: expect.arrayContaining([
      expect.objectContaining({
        logical_path: "main.js",
        classification: "contradiction",
        dimensions: ["integrity"],
      }),
    ]),
  });
  const changed = parseEvidence(
    await call(client, "compare_artifacts", {
      left: control.evidence,
      right: verified.evidence,
    }),
  );
  expect(changed.normalized_result).toMatchObject({
    changes: expect.arrayContaining([
      expect.objectContaining({
        logical_path: "main.js",
        classification: "changed",
      }),
    ]),
  });
  const left = capture("before");
  const right = capture("after");
  const runtime = parseEvidence(
    await call(client, "compare_process_captures", { left, right }),
  );
  expect(runtime.normalized_result).toMatchObject({ terminal: "changed" });
  const correlate = async (comparison: Evidence) =>
    parseEvidence(
      await call(client, "correlate_static_and_runtime", {
        static_comparisons: [comparison],
        runtime_comparisons: [runtime],
        mappings: [
          {
            static: {
              comparison_evidence_id: comparison.evidence_id,
              selector: { kind: "artifact", logical_path: "main.js" },
            },
            runtime: {
              comparison_evidence_id: runtime.evidence_id,
              dimension: "terminal",
            },
            side_alignment: "left_to_left",
            hypothesis: {
              statement: "Static member change co-occurs with terminal change.",
              expected_pattern: "cochanged",
            },
          },
        ],
      }),
    );
  const unknowns = () =>
    session.listUnknowns({ domain: "static-runtime-correlation" });
  expect(unknowns()).toEqual([]);
  const bad = await correlate(contradicted);
  const result = staticRuntimeCorrelationResultSchema.parse(
    bad.normalized_result,
  );
  expect(result).toMatchObject({
    status: "unknown",
    summary: { hypotheses: 0, contradictions: 0, unresolved: 1 },
    correlations: {
      items: [
        {
          static: { status: "contradiction", conclusion_kind: "contradiction" },
          runtime: { status: "changed" },
          observed_pattern: "unknown",
          classification: "unresolved_branch",
        },
      ],
    },
  });
  const links = [
    contradicted,
    stale.evidence,
    verified.evidence,
    runtime,
    left,
    right,
  ].map(({ evidence_id }) => evidence_id);
  expect(result.correlations.items[0]?.evidence_links).toEqual(
    expect.arrayContaining(links),
  );
  expect(bad.evidence_links).toEqual(expect.arrayContaining(links));
  const unresolved = unknowns();
  expect(unresolved).toMatchObject([
    { supporting_evidence_ids: [bad.evidence_id] },
  ]);
  const good = await correlate(changed);
  const positive = staticRuntimeCorrelationResultSchema.parse(
    good.normalized_result,
  );
  expect(positive.status).toBe("correlated");
  expect(positive.summary).toEqual({
    hypotheses: 1,
    contradictions: 0,
    unresolved: 0,
  });
  expect(positive.correlations.items[0]).toMatchObject({
    static: { status: "changed", conclusion_kind: "derived_relationship" },
    observed_pattern: "cochanged",
    classification: "hypothesis",
  });
  expect(unknowns()).toEqual(unresolved);
  for (const evidence of [
    contradicted,
    changed,
    stale.evidence,
    verified.evidence,
    control.evidence,
    runtime,
    left,
    right,
    bad,
    good,
  ])
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
});
