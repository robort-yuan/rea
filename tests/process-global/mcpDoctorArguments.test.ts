import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { runProductionMcpDoctorCli } from "../../src/mcpDoctor.js";

const input = { dispatcherPath: "not-started", packageRoot: process.cwd() };
const unknownOption = "Unknown mcp doctor option: --bogus";

beforeEach(() => {
  const unexpectedStartup = new Error(
    "Argument-only invocations must not start MCP",
  );
  vi.spyOn(Client.prototype, "connect").mockRejectedValue(unexpectedStartup);
  vi.spyOn(StdioClientTransport.prototype, "start").mockRejectedValue(
    unexpectedStartup,
  );
});

afterEach(() => {
  try {
    expect(Client.prototype.connect).not.toHaveBeenCalled();
    expect(StdioClientTransport.prototype.start).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

describe("MCP doctor argument validation", () => {
  it.each([
    { args: ["--bogus", "--full-output", "--json"], message: unknownOption },
    { args: ["--json", "--bogus", "--full-output"], message: unknownOption },
    { args: ["--json", "--full-output", "--bogus"], message: unknownOption },
    { args: ["--full-output", "--bogus", "--json"], message: unknownOption },
    {
      args: ["--format", "invalid", "--full-output", "--json"],
      message: "Invalid output format: invalid",
    },
    {
      args: ["--json", "--full-output", "--format", "invalid"],
      message: "Invalid output format: invalid",
    },
    {
      args: ["--format=invalid", "--full-output", "--json"],
      message: "Invalid output format: invalid",
    },
    {
      args: ["--full-output", "--json", "--format"],
      message: "Invalid output format: missing",
    },
    {
      args: ["--format=", "--full-output", "--json"],
      message: "Invalid output format: ",
    },
    {
      args: ["--bogus", "--format", "invalid", "--full-output", "--json"],
      message: unknownOption,
    },
    {
      args: ["--format", "invalid", "--bogus", "--full-output", "--json"],
      message: "Invalid output format: invalid",
    },
    {
      args: ["--bogus", "--format", "json", "--full-output"],
      message: unknownOption,
    },
    {
      args: ["--bogus", "--format=json", "--full-output"],
      message: unknownOption,
    },
    {
      args: ["--format", "invalid", "--format", "json", "--full-output"],
      message: "Invalid output format: invalid",
    },
  ])(
    "retains the first error and requested envelope: $args",
    async ({ args, message }) => {
      const result = await runProductionMcpDoctorCli(args, input);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toEqual({
        ok: false,
        error: { code: "VALIDATION_ERROR", message },
      });
    },
  );

  it.each([
    { args: ["--bogus", "--json"], message: unknownOption },
    { args: ["--json", "--bogus"], message: unknownOption },
    {
      args: ["--format=invalid", "--json"],
      message: "Invalid output format: invalid",
    },
    { args: ["--json", "--format"], message: "Invalid output format: missing" },
    { args: ["--json", "--format="], message: "Invalid output format: " },
  ])(
    "keeps bare errors when no envelope is requested: $args",
    async ({ args, message }) => {
      const result = await runProductionMcpDoctorCli(args, input);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toEqual({
        code: "VALIDATION_ERROR",
        message,
      });
    },
  );

  it.each(["json", "jsonl", "yaml"] as const)(
    "uses the last valid %s format after an error",
    async (format) => {
      const result = await runProductionMcpDoctorCli(
        [
          "--format",
          "md",
          "--bogus",
          "--json",
          "--full-output",
          `--format=${format}`,
        ],
        input,
      );
      expect(result.exitCode).toBe(1);
      const document =
        format === "yaml"
          ? parseYaml(result.output)
          : JSON.parse(result.output);
      expect(document).toEqual({
        ok: false,
        error: { code: "VALIDATION_ERROR", message: unknownOption },
      });
      if (format === "jsonl")
        expect(result.output.trim().split("\n")).toHaveLength(1);
    },
  );
});

describe("MCP doctor option positions", () => {
  it.each(["toon", "md"] as const)(
    "keeps the requested %s presentation after an error",
    async (format) => {
      const result = await runProductionMcpDoctorCli(
        ["--bogus", "--json", "--full-output", "--format", format],
        input,
      );
      expect(result.exitCode).toBe(1);
      if (format === "toon")
        expect(result.output).toBe(
          'ok: false\nerror:\n  code: VALIDATION_ERROR\n  message: "Unknown mcp doctor option: --bogus"\n',
        );
      else {
        expect(result.output).toContain("## ok\n\nfalse\n\n## error\n");
        expect(result.output).toContain("VALIDATION_ERROR");
        expect(result.output).toContain(unknownOption);
      }
    },
  );

  it("does not reinterpret a consumed full-output flag", async () => {
    const result = await runProductionMcpDoctorCli(
      ["--format", "--full-output", "--json"],
      input,
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toEqual({
      code: "VALIDATION_ERROR",
      message: "Invalid output format: --full-output",
    });
  });

  it("does not reinterpret a consumed JSON flag", async () => {
    const result = await runProductionMcpDoctorCli(
      ["--format", "--json"],
      input,
    );
    expect(result).toEqual({
      exitCode: 1,
      output:
        'code: VALIDATION_ERROR\nmessage: "Invalid output format: --json"\n',
    });
  });

  it.each(["--help", "-h", "--json", "--full-output", "--format=json"])(
    "consumes %s as a format value before later selectors",
    async (value) => {
      const result = await runProductionMcpDoctorCli(
        ["--format", value, "--json", "--full-output"],
        input,
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toEqual({
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid output format: ${value}`,
        },
      });
    },
  );

  it.each([
    ["--bogus", "--help", "--format"],
    ["-h", "--bogus", "--format", "invalid"],
    ["--format", "invalid", "--help", "--json"],
    ["--format", "--help", "-h"],
  ])("honors help only in option position: %j", async (...args) => {
    const result = await runProductionMcpDoctorCli(args, input);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Usage: rea mcp doctor [options]");
    expect(result.output).not.toContain("VALIDATION_ERROR");
  });
});
