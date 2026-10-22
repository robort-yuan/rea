#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { PrivateRuntimeRoot } from "../dist/process/PrivateRuntimeRoot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import {
  mcpTextValue,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { WABT_OPERATION_TIMEOUT_MS } from "./lib/wabt-verifier-timeouts.mjs";

import { verifyWabtCleanup } from "./lib/verify-wabt-cleanup.mjs";

const directory = process.env.REA_WABT_BIN_DIRECTORY;
if (!isAbsolute(directory ?? "")) {
  if (process.argv.includes("--require-tools"))
    throw new Error(
      "Supply absolute REA_WABT_BIN_DIRECTORY containing WABT 1.0.42 tools.",
    );
  console.log(
    JSON.stringify({
      status: "skipped",
      reason:
        "WABT real-tool lane requires caller-supplied REA_WABT_BIN_DIRECTORY; no tools installed.",
    }),
  );
  process.exit(0);
}
const entrypoint =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
  fileURLToPath(new URL("./rea.mjs", import.meta.url));
const execute = promisify(execFile);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const toolPath = (tool) =>
  join(directory, `${tool}${process.platform === "win32" ? ".exe" : ""}`);
const tool = (name, args, cwd, maxBuffer = 32 * 1024 * 1024) =>
  execute(toolPath(name), args, {
    cwd,
    env: environment,
    timeout: 30_000,
    maxBuffer,
  });
// Deterministic compiler-like code whose WAT expands about 10x its bytes.
const codeHeavySource = (functions) => {
  let seed = 1234;
  const next = (bound) =>
    (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % bound;
  const lines = ["(module", "  (type $t (func (param i32 i32) (result i32)))"];
  for (let index = 0; index < functions; index += 1)
    lines.push(
      `  (func $f${index} (export "f${index}") (type $t) (param $a i32) (param $b i32) (result i32)`,
      "    (local $i i32) (local $acc i32) (local $x i64)",
      "    block $exit",
      "      loop $top",
      "        local.get $i local.get $b i32.ge_u br_if $exit",
      `        local.get $a local.get $i i32.const 2 i32.shl i32.add i32.const ${next(1 << 14)} i32.add`,
      `        local.get $acc i32.add i32.const ${next(1 << 30)} i32.xor local.set $acc`,
      "        block $c1 block $c0",
      "          local.get $acc i32.const 1 i32.and br_table $c0 $c1 $c0",
      "        end",
      `          local.get $acc i64.extend_i32_u local.get $x i64.add i64.const ${next(1 << 30)} i64.mul local.set $x br $c1`,
      "        end",
      `        local.get $acc local.get $i call $f${next(index + 1)} local.set $acc`,
      "        local.get $i i32.const 1 i32.add local.set $i br $top",
      "      end",
      "    end",
      "    local.get $acc local.get $x i32.wrap_i64 i32.add)",
    );
  lines.push(")");
  return `${lines.join("\n")}\n`;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const run = createVerifierRun();
const root = await PrivateRuntimeRoot.create({ prefix: "rea-wabt-verifier-" });
// Keep provider scratch outside the leased private input root. On Windows the
// root's retained DELETE handle blocks child temp creation beneath that root.
let childTempRoot;
try {
  childTempRoot = await mkdtemp(join(tmpdir(), "rea-wabt-child-temp-"));
} catch (cause) {
  try {
    await root.close();
  } catch (cleanupCause) {
    throw new AggregateError(
      [cause, cleanupCause],
      "Could not allocate verifier temp space or release its private root.",
    );
  }
  throw cause;
}
const client = new Client({ name: "wabt-artifact-verifier", version: "1" });
// Drop every spelling of the budget override so the server default matches
// the client's receive buffer.
const mcpEnvironment = Object.fromEntries(
  Object.entries(environment).filter(
    ([name]) => name.toUpperCase() !== "REA_MCP_MAX_RESPONSE_BYTES",
  ),
);
const callTool = (request) =>
  client.callTool(request, { timeout: WABT_OPERATION_TIMEOUT_MS });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: {
    ...mcpEnvironment,
    TMPDIR: childTempRoot,
    TMP: childTempRoot,
    TEMP: childTempRoot,
  },
  stderr: "pipe",
});
let cases = 0;
const failures = [];
const retainedEvidence = async (evidenceId) => {
  const reply = await callTool({
    name: "get_evidence_bundle",
    arguments: {},
  });
  assert.notEqual(reply.isError, true, mcpTextValue(reply));
  const record = JSON.parse(mcpTextValue(reply)).result.records.find(
    ({ evidence_id }) => evidence_id === evidenceId,
  );
  assert.ok(record, `Missing retained Evidence ${evidenceId}`);
  return parseEvidence(record);
};
try {
  for (const name of ["wat2wasm", "wasm-validate", "wasm-objdump", "wasm2wat"])
    assert.equal(
      (await tool(name, ["--version"], root.path)).stdout.trim(),
      "1.0.42",
    );
  await client.connect(transport);
  const advertised = (await client.listTools()).tools.find(
    ({ name }) => name === "inspect_wasm_artifact",
  );
  assert.ok(advertised?.outputSchema, "WASM tool must advertise output schema");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  assert.ok(ajv.validateSchema(advertised.inputSchema));
  assert.ok(ajv.validateSchema(advertised.outputSchema));
  const inspectCli = async (input) => {
    try {
      return JSON.parse(
        (
          await execute(
            process.execPath,
            [
              entrypoint,
              "inspect-wasm-artifact",
              input.path,
              ...(input.command_timeout_ms === undefined
                ? []
                : ["--command-timeout-ms", String(input.command_timeout_ms)]),
              ...input.glue_paths.flatMap((path) => ["--glue_paths", path]),
              ...input.candidate_paths.flatMap((path) => [
                "--candidate_paths",
                path,
              ]),
              "--format",
              "json",
            ],
            {
              env: {
                ...environment,
                TMPDIR: childTempRoot,
                TMP: childTempRoot,
                TEMP: childTempRoot,
              },
              timeout: WABT_OPERATION_TIMEOUT_MS,
              maxBuffer: 64 * 1024 * 1024,
            },
          )
        ).stdout,
      );
    } catch (cause) {
      if (typeof cause.code === "number" && typeof cause.stdout === "string")
        return JSON.parse(cause.stdout);
      throw cause;
    }
  };
  const sources = [
    await readFile(
      new URL("../tests/fixtures/wasm/module.wat", import.meta.url),
      "utf8",
    ),
    "(module)\n",
    '(module (import "env.with.dot" "field.with.dot" (global i32)) (import "env" "table" (table 1 funcref)) (memory (export "memory") 1) (export "g" (global 0)) (export "t" (table 0)) (func (export "name\\0aline") (result i32) i32.const 42))\n',
    await readFile(
      new URL("../tests/fixtures/wasm/custom-names.wat", import.meta.url),
      "utf8",
    ),
    `(module
  (memory 1)
  (data "x")
  (func (export "init")
    i32.const 0
    i32.const 0
    i32.const 1
    memory.init 0
    data.drop 0))\n`,
  ].map((source) => ({ source, debugNames: false }));
  sources.push(
    {
      source:
        '(module $named (func (export "answer") (result i32) i32.const 42))\n',
      debugNames: true,
    },
    {
      source: await readFile(
        new URL("../tests/fixtures/wasm/module-names.wat", import.meta.url),
        "utf8",
      ),
      debugNames: false,
    },
  );
  for (const [index, { source, debugNames }] of sources.entries()) {
    const fixtureRoot = join(root.path, `fixture-${index}`);
    await mkdir(fixtureRoot);
    const path = join(fixtureRoot, "module.wasm");
    await writeFile(join(fixtureRoot, "source.wat"), source);
    await tool(
      "wat2wasm",
      [
        "--enable-all",
        ...(debugNames ? ["--debug-names"] : []),
        "source.wat",
        "-o",
        "module.wasm",
      ],
      fixtureRoot,
    );
    await tool("wasm-validate", ["--enable-all", "module.wasm"], fixtureRoot);
    const original = await readFile(path);
    // Independent modes avoid treating a custom name's text as a framing marker.
    const headers = (
      await tool("wasm-objdump", ["-h", "module.wasm"], fixtureRoot)
    ).stdout;
    const details = (
      await tool("wasm-objdump", ["-x", "module.wasm"], fixtureRoot)
    ).stdout;
    const wat = (
      await tool("wasm2wat", ["--enable-all", "module.wasm"], fixtureRoot)
    ).stdout;
    await writeFile(join(fixtureRoot, "decoded.wat"), wat);
    await tool(
      "wat2wasm",
      ["--enable-all", "decoded.wat", "-o", "roundtrip.wasm"],
      fixtureRoot,
    );
    await tool(
      "wasm-validate",
      ["--enable-all", "roundtrip.wasm"],
      fixtureRoot,
    );
    const candidateRoot = join(fixtureRoot, "other");
    await mkdir(candidateRoot);
    const candidate = join(candidateRoot, "module.wasm");
    await writeFile(join(candidateRoot, "source.wat"), "(module (memory 2))");
    await tool("wat2wasm", ["source.wat", "-o", "module.wasm"], candidateRoot);
    const glueSource =
      'fetch("./module.wasm"); new URL("https://example.invalid/module.wasm?version=1", import.meta.url);';
    const glueSources = [
      glueSource,
      `\uFEFF${glueSource}`,
      `\uFEFF\n${glueSource}`,
      `#!/usr/bin/env node\n${glueSource}`,
      `\uFEFF#!/usr/bin/env node\n${glueSource}`,
    ];
    const gluePaths = glueSources.map((_, index) =>
      join(fixtureRoot, `glue-${index}.js`),
    );
    for (const [index, gluePath] of gluePaths.entries())
      await writeFile(gluePath, glueSources[index]);
    const input = {
      path,
      glue_paths: gluePaths,
      candidate_paths: [candidate],
      ...(index === 0 ? { command_timeout_ms: 60_000 } : {}),
    };
    assert.ok(ajv.validate(advertised.inputSchema, input));
    const cliValue = await inspectCli(input);
    assert.equal(cliValue.category, undefined, JSON.stringify(cliValue));
    const cli = parseEvidence(cliValue);
    const reply = await callTool({
      name: "inspect_wasm_artifact",
      arguments: input,
    });
    assert.notEqual(reply.isError, true, mcpTextValue(reply));
    assert.ok(
      ajv.validate(advertised.outputSchema, reply.structuredContent),
      JSON.stringify(ajv.errors),
    );
    const mcp = parseEvidence(reply.structuredContent);
    assert.equal(cli.evidence_id, mcp.evidence_id);
    assert.deepEqual(cli, mcp);
    const report = mcp.normalized_result;
    assert.equal(
      report.tool_profile.timeout_ms,
      input.command_timeout_ms ?? 30_000,
    );
    assert.equal(mcp.parameters.command_timeout_ms, input.command_timeout_ms);
    assert.equal(report.artifact.sha256, sha256(original));
    assert.equal(report.artifact.bytes, original.length);
    assert.equal(report.wat.text, wat);
    assert.equal(report.wat.sha256, sha256(wat));
    assert.equal(report.headers, `${headers}\n`);
    assert.equal(report.details, details.slice(1));
    assert.equal(report.glue.length, glueSources.length);
    for (const [index, source] of glueSources.entries()) {
      const observed = report.glue[index];
      assert.equal(observed.artifact.path, gluePaths[index]);
      assert.equal(observed.artifact.sha256, sha256(source));
      assert.equal(observed.artifact.bytes, Buffer.byteLength(source));
      assert.equal(await readFile(gluePaths[index], "utf8"), source);
      assert.equal(observed.parse_status, "complete");
      assert.deepEqual(
        observed.references.map(({ candidate_paths }) => candidate_paths),
        [[path], [path, candidate]],
      );
      assert.deepEqual(
        observed.references.map(({ line, column }) => ({ line, column })),
        ["./module.wasm", "https://example.invalid/module.wasm?version=1"].map(
          (value) => {
            const offset = source.indexOf(`"${value}"`);
            return {
              line: source.slice(0, offset).split("\n").length,
              column: offset - source.lastIndexOf("\n", offset) - 1,
            };
          },
        ),
      );
    }
    assert.notEqual(report.candidates[0].sha256, report.candidates[1].sha256);
    for (const command of report.tool_profile.commands)
      assert.equal(command.sha256, sha256(await readFile(command.path)));
    if (index === 0) {
      assert.ok(
        report.sections.some(
          ({ kind, description }) =>
            kind === "Custom" && description === '"test"',
        ),
      );
      assert.ok(report.wat.text.includes('(@custom "test" "payload")'));
      assert.equal(
        sha256(await readFile(join(fixtureRoot, "roundtrip.wasm"))),
        sha256(original),
      );
    }
    if (index === 3)
      assert.deepEqual(
        report.sections.map(({ description }) => description),
        [
          '"test\nline"',
          '"fake"\nSection Details:\n   Type start=0x0000000a end=0x0000000b (size=0x00000001) count: 0\n"end"',
          '"unicode-é\\\t"',
          '"visible"',
          '"\uFEFFsection"',
          '"\uFEFFname"',
          '"\uFEFF"',
          '""',
        ],
      );
    if (debugNames) {
      assert.ok(report.headers.includes("\nmodule name: <named>\n"));
      assert.deepEqual(report.exports, ['(export "answer" (func 0))']);
    }
    if (index === 4) {
      assert.match(
        headers,
        /^DataCount start=0x[\da-f]+ end=0x[\da-f]+ \(size=0x[\da-f]+\) count: 1$/m,
      );
      assert.deepEqual(
        report.sections.find(({ kind }) => kind === "DataCount"),
        {
          kind: "DataCount",
          start: 0x23,
          end: 0x24,
          bytes: 1,
          description: "count: 1",
        },
      );
    }
    assert.deepEqual(await retainedEvidence(mcp.evidence_id), mcp);
    assert.deepEqual(await readFile(path), original);
    cases += 2;
    for (const [label, invalidBytes] of [
      ["truncated", original.subarray(0, 7)],
      ["invalid", Buffer.from("not a wasm module")],
    ]) {
      const invalidPath = join(fixtureRoot, `${label}.wasm`);
      await writeFile(invalidPath, invalidBytes);
      const invalidInput = {
        path: invalidPath,
        glue_paths: [],
        candidate_paths: [],
        ...(index === 0 ? { command_timeout_ms: 42_000 } : {}),
      };
      const cliError = await inspectCli(invalidInput);
      assert.equal(
        cliError.category,
        "invalid_input",
        JSON.stringify(cliError),
      );
      const error = requireMcpToolError(
        await callTool({
          name: "inspect_wasm_artifact",
          arguments: invalidInput,
        }),
      );
      assert.equal(error.category, "invalid_input");
      const reference = error.details.partial_observation;
      assert.equal(reference.kind, "retained-evidence");
      const failed = await retainedEvidence(reference.evidence_id);
      assert.equal(failed.subject.digest.sha256, sha256(invalidBytes));
      assert.equal(
        failed.normalized_result.tool_profile.timeout_ms,
        invalidInput.command_timeout_ms ?? 30_000,
      );
      assert.equal(
        failed.normalized_result.tool_profile.output_budget_bytes,
        128 * 1024 * 1024,
      );
      assert.equal(
        failed.normalized_result.validation,
        "rejected-by-selected-profile",
      );
      assert.equal(
        cliError.details.partial_observation.evidence_id,
        failed.evidence_id,
      );
      assert.ok(
        error.details?.captured_output?.stderr?.length > 0,
        JSON.stringify(error),
      );
      assert.deepEqual(await readFile(invalidPath), invalidBytes);
      cases += 2;
    }
  }
  const largeRoot = join(root.path, "fixture-code-heavy");
  await mkdir(largeRoot);
  await writeFile(join(largeRoot, "source.wat"), codeHeavySource(36_000));
  await tool(
    "wat2wasm",
    ["--enable-all", "source.wat", "-o", "module.wasm"],
    largeRoot,
  );
  const largePath = join(largeRoot, "module.wasm");
  const largeBytes = await readFile(largePath);
  const largeWat = (
    await tool(
      "wasm2wat",
      ["--enable-all", "module.wasm"],
      largeRoot,
      64 * 1024 * 1024,
    )
  ).stdout;
  assert.ok(largeBytes.length < 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(largeWat) > 32 * 1024 * 1024);
  const largeInput = { path: largePath, glue_paths: [], candidate_paths: [] };
  const largeCli = await inspectCli(largeInput);
  assert.equal(largeCli.category, undefined, largeCli.message);
  const largeReport = parseEvidence(largeCli).normalized_result;
  assert.equal(largeReport.artifact.sha256, sha256(largeBytes));
  assert.equal(largeReport.wat.sha256, sha256(largeWat));
  assert.equal(largeReport.wat.text.length, largeWat.length);
  assert.equal(largeReport.tool_profile.output_budget_bytes, 128 * 1024 * 1024);
  assert.equal(largeReport.tool_profile.timeout_ms, 30_000);
  assert.ok(
    largeReport.limitations.some((text) =>
      text.includes("fixed 128 MiB combined output budget"),
    ),
  );
  const largeError = requireMcpToolError(
    await callTool({
      name: "inspect_wasm_artifact",
      arguments: largeInput,
    }),
  );
  assert.equal(largeError.category, "resource_constraint");
  assert.equal(largeError.details.resource, "transport");
  const largeReference = largeError.details.reported_limits.evidence_reference;
  assert.deepEqual(largeReference, {
    kind: "retained-evidence",
    evidence_id: largeCli.evidence_id,
  });
  const largeSummary = await callTool({
    name: "inspect_wasm_artifact",
    arguments: { ...largeInput, detail: "summary" },
  });
  assert.notEqual(largeSummary.isError, true, mcpTextValue(largeSummary));
  const summary = parseEvidence(
    largeSummary.structuredContent,
  ).normalized_result;
  assert.equal(summary.parent_evidence_id, largeCli.evidence_id);
  assert.equal(summary.summary.wat.sha256, sha256(largeWat));
  const largePage = await callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: largeReference,
      view: { kind: "wasm", facet: "wat", offset: 0, limit: 16 },
    },
  });
  assert.notEqual(largePage.isError, true, mcpTextValue(largePage));
  assert.equal(
    parseEvidence(largePage.structuredContent).normalized_result.item.text,
    largeWat.slice(0, 16),
  );
  cases += 3;
  cases += await verifyWabtCleanup(entrypoint, environment, childTempRoot);
} catch (cause) {
  failures.push(cause);
}
try {
  await client.close();
} catch (cause) {
  failures.push(cause);
}
try {
  await transport.close();
} catch (cause) {
  failures.push(cause);
}
try {
  assert.ok(
    !(await readdir(childTempRoot)).some((name) =>
      name.startsWith("rea-wabt-"),
    ),
    "Provider workspace leaked",
  );
} catch (cause) {
  failures.push(cause);
}
// Each directory is an independent owner. Attempt every cleanup even if a
// residue assertion or another owner's close fails, retaining every error.
try {
  await root.close();
} catch (cause) {
  failures.push(cause);
}
try {
  await rm(childTempRoot, { recursive: true, force: true });
} catch (cause) {
  failures.push(cause);
}
if (failures.length > 0)
  throw new AggregateError(failures, "WABT real-tool verification failed.");
console.log(
  JSON.stringify(
    {
      status: "passed",
      cases,
      tool_profile: "wabt@1.0.42",
      entrypoint,
      verifier: await completeVerifierRun(run),
    },
    null,
    2,
  ),
);
