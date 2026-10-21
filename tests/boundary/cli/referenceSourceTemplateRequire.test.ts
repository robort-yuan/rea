import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// Reference-source reads require no-follow opens; Windows reports unsupported.
describe.skipIf(process.platform === "win32")(
  "compiled reference-source template requires",
  () => {
    cliTest(
      "retains exact CommonJS templates without guessing computed or shadowed targets",
      async ({ cli }) => {
        const workspace = await createTestTempDirectory(
          "rea-reference-template-",
        );
        const root = join(workspace, "source");
        await mkdir(root);
        const sources = {
          "quoted.cjs": 'require("./dep.cjs"); require("node:fs");',
          "template.cjs": "require(`./dep.cjs`); require(`node:fs`);",
          "escaped.cjs": "require(`./dep\\u002ecjs`);",
          "resolve.cjs": "require.resolve(`./dep.cjs`);",
          "computed.cjs":
            "require(`./${name}.cjs`); require(String.raw`./dep.cjs`);",
          "shadowed.cjs":
            "function load(require) { return require(`./dep.cjs`); }",
          "mutated.cjs": "require = () => {}; require(`./dep.cjs`);",
          "unbound.mjs": "require(`./dep.cjs`);",
          "dynamic.mjs": "import(`./${name}.cjs`);",
          "dep.cjs": 'throw new Error("Reference sources must not execute");',
        };
        await Promise.all(
          Object.entries(sources).map(([path, source]) =>
            writeFile(join(root, path), source),
          ),
        );

        const result = await cli.run({
          arguments: ["import-reference-source", root, "--json"],
          environment: {
            HOME: workspace,
            XDG_CONFIG_HOME: workspace,
            XDG_CACHE_HOME: workspace,
          },
        });
        expect(result.exitCode).toBe(0);
        const graph = historicalSourceGraphSchema.parse(result.json);
        expect(graph.parse_failures).toEqual([]);
        expect(graph.relationships).toHaveLength(7);
        for (const from_path of [
          "quoted.cjs",
          "template.cjs",
          "escaped.cjs",
          "resolve.cjs",
        ])
          expect(graph.relationships).toContainEqual({
            from_path,
            to: "dep.cjs",
            kind: "requires",
            resolution: "internal",
            parse_state: "parsed",
          });
        for (const from_path of ["quoted.cjs", "template.cjs"])
          expect(graph.relationships).toContainEqual({
            from_path,
            to: "node:fs",
            kind: "requires",
            resolution: "external",
            parse_state: "parsed",
          });
        expect(graph.relationships).toContainEqual({
          from_path: "dynamic.mjs",
          to: "<dynamic-import>",
          kind: "imports",
          resolution: "unknown",
          parse_state: "partial",
        });
        for (const [path, source] of Object.entries(sources))
          expect(graph.entries).toContainEqual(
            expect.objectContaining({
              path,
              sha256: createHash("sha256").update(source).digest("hex"),
              content_state: "hashed",
            }),
          );
      },
    );
  },
);
