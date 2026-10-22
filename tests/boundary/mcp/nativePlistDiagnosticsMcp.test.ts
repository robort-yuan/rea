import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const runFile = promisify(execFile);

it.skipIf(process.platform !== "darwin")(
  "reads an explicit plist path through MCP without an open target",
  async () => {
    const root = await createTestTempDirectory("rea-plist-standalone-mcp-");
    const path = join(root, "Info.plist");
    await writeFile(
      path,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.rea.fixture</string></dict></plist>',
    );
    const { call } = await connectLocalToolsMcp({
      HOME: root,
      USERPROFILE: root,
    });
    const result = await call("inspect_plist", { path });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain(
      "dev.rea.fixture",
    );
    const binary = join(root, "BinarySettings");
    await runFile("/usr/bin/plutil", [
      "-convert",
      "binary1",
      "-o",
      binary,
      path,
    ]);
    const binaryRead = await call("inspect_plist", { path: binary });
    expect(binaryRead.isError).not.toBe(true);
    expect(binaryRead.structuredContent).toMatchObject({
      normalized_result: {
        format: "binary",
        value: { CFBundleIdentifier: "dev.rea.fixture" },
        source_path: binary,
      },
    });
    // Target-format detection does not recognize suffixless OpenStep text.
    for (const name of ["Settings", "Localizable.strings"]) {
      const openStep = join(root, name);
      await writeFile(openStep, "{ Name = Example; }\n");
      const read = await call("inspect_plist", { path: openStep });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({
        normalized_result: {
          value: { Name: "Example" },
          source_path: openStep,
        },
      });
    }
    const status = await call("binary_session", {});
    expect(status.structuredContent).toMatchObject({
      result: { open: false },
    });
  },
);

it.skipIf(process.platform !== "darwin")(
  "preserves real plutil diagnostics and typed selection failures through MCP",
  async () => {
    const root = await createTestTempDirectory("rea-plist-diagnostic-mcp-");
    const program = join(root, "program");
    await writeFile(program, thinMach(0xfeedfacf, 0x100000c));
    await mkdir(join(root, "Contents"));
    const path = join(root, "Contents/Info.plist");
    const source =
      "<plist><dict><key>number</key><integer> 42 </integer></dict></plist>";
    await writeFile(path, source);
    const { call } = await connectLocalToolsMcp({
      HOME: root,
      USERPROFILE: root,
    });
    const opened = await call("open_binary", { path: program });
    expect(opened.isError).not.toBe(true);
    for (const selected of [undefined, path]) {
      const result = await call(
        "inspect_plist",
        selected === undefined ? {} : { path: selected },
      );
      const { error } = parseMcpToolError(result);
      if (
        error.code !== "invalid_request" &&
        error.code !== "capability_unavailable"
      )
        throw new Error(`Unexpected failure: ${error.code}`);
      expect(error.code).toBe(
        selected === undefined ? "capability_unavailable" : "invalid_request",
      );
      const text =
        selected === undefined
          ? error.message
          : JSON.stringify(error.details?.issues);
      expect(text).toContain("Property List error:");
      expect(error.details).toMatchObject({
        captured_output: { exit_code: 1, truncated: false },
      });
      expect(JSON.stringify(error.details?.captured_output)).toContain(
        "Property List error:",
      );
    }
    const selectedTarget = await call("open_binary", { path });
    expect(selectedTarget.isError).not.toBe(true);
    const direct = parseMcpToolError(await call("inspect_plist", {})).error;
    expect(direct).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["path"],
            message: expect.stringContaining("Property List error:"),
          },
        ],
        captured_output: { exit_code: 1, truncated: false },
      },
    });
    expect(await readFile(path, "utf8")).toBe(source);
  },
);
