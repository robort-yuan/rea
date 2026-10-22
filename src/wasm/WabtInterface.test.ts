import { expect, it } from "vitest";
import { parseWabtWat } from "./WabtWat.js";

it.each([
  ["func", "(param i32)", "(param i64)", { params: ["i64"], results: [] }],
  ["table", "1 funcref", "2 externref", { minimum: "2", element: "externref" }],
  ["memory", "1", "2", { minimum: "2" }],
  ["global", "i32", "i64 (i64.const 0)", { value_type: "i64", mutable: false }],
  ["tag", "(param i32)", "(param i64)", { params: ["i64"], results: [] }],
])(
  "keeps colliding %s labels unknown across imported and defined entries",
  (kind, imported, defined, expected) => {
    // WABT 1.0.42 renders debug names "a b" and "a_b" as $a_b.
    const report = parseWabtWat(`(module
    (import "env" "original" (${kind} $a_b ${imported}))
    (${kind} $a_b ${defined})
    (export "first" (${kind} $a_b))
    (export "second" (${kind} $a_b))
    (export "numeric" (${kind} 1)))`).interface;
    expect(report.state).toBe("complete");
    expect(report.issues).toEqual([]);
    expect(report.entries).toHaveLength(4);
    expect(report.entries[0]).toMatchObject({
      index: 0,
      signature: { kind },
      issue: null,
    });
    for (const entry of report.entries.slice(1, 3))
      expect(entry).toMatchObject({
        index: null,
        signature: null,
        issue: expect.any(String),
        wat_form: `(export "${entry.name}" (${kind} $a_b))`,
      });
    expect(report.entries[3]).toMatchObject({
      index: 1,
      signature: { kind, ...expected },
      issue: null,
    });
  },
);

it.each(["func", "tag"])(
  "does not choose the last colliding named type for a %s",
  (kind) => {
    // Captured WABT type labels for distinct debug names "t x" and "t_x".
    const report = parseWabtWat(`(module
    (type $t_x (func (param i32)))
    (type $t_x (func (param i64)))
    (type $unique (func (param f32)))
    (import "env" "ambiguous" (${kind} $imported (type $t_x)))
    (${kind} $defined (type $t_x) (param i64))
    (${kind} $numeric (type 0))
    (${kind} $unique (type $unique))
    (export "defined" (${kind} $defined))
    (export "numeric" (${kind} $numeric))
    (export "unique" (${kind} $unique)))`).interface;
    expect(report.state).toBe("complete");
    expect(report.entries).toHaveLength(4);
    for (const [index, entry] of report.entries.slice(0, 2).entries())
      expect(entry).toMatchObject({
        index,
        signature: null,
        issue: expect.any(String),
      });
    expect(report.entries.slice(2)).toMatchObject([
      {
        index: 2,
        signature: { kind, params: ["i32"], results: [] },
        issue: null,
      },
      {
        index: 3,
        signature: { kind, params: ["f32"], results: [] },
        issue: null,
      },
    ]);
  },
);

it("resolves imported index spaces and decoded escaped names without depending on body/type numbering", () => {
  const report = parseWabtWat(`(module
    (type (;0;) (func (param i32) (result i64)))
    (import "a\\22b" "\\ef\\bb\\bf\\00" (func (;0;) (type 0)))
    (func (;1;) (type 0) (param i32) (result i64) local.get 0 i64.extend_i32_s)
    (export "" (func 1)))`).interface;
  expect(report.entries).toMatchObject([
    {
      direction: "import",
      module: 'a"b',
      name: "\ufeff\0",
      index: 0,
      signature: { kind: "func", params: ["i32"], results: ["i64"] },
    },
    {
      direction: "export",
      name: "",
      index: 1,
      signature: { kind: "func", params: ["i32"], results: ["i64"] },
    },
  ]);
});

it("retains exact memory/table/global/tag declarations and keeps unsupported references unknown", () => {
  const report = parseWabtWat(`(module
    (type (func (param i32)))
    (type (struct (field i32)))
    (import "env" "table" (table 1 3 funcref))
    (memory i64 2 4 shared)
    (global (mut i64) (i64.const 1))
    (tag (type 0))
    (func (type 0))
    (func (param (ref null 1)))
    (export "memory" (memory 0)) (export "global" (global 0))
    (export "tag" (tag 0)) (export "gc" (func 1)))`).interface;
  expect(report.entries.map((e) => e.signature)).toEqual([
    {
      kind: "table",
      element: "funcref",
      address_type: "i32",
      minimum: "1",
      maximum: "3",
      shared: false,
    },
    {
      kind: "memory",
      page_size: "65536",
      address_type: "i64",
      minimum: "2",
      maximum: "4",
      shared: true,
    },
    { kind: "global", value_type: "i64", mutable: true },
    { kind: "tag", params: ["i32"], results: [] },
    null,
  ]);
  expect(report.entries[4]?.issue).toBeTruthy();
});

it("does not bind recursive-type index spaces by guessing their cardinality", () => {
  const report = parseWabtWat(
    `(module (rec (type (struct)) (type (func))) (func (type 1)) (export "f" (func 0)))`,
  ).interface;
  expect(report.entries).toMatchObject([
    { name: "f", signature: null, issue: expect.any(String) },
  ]);
});

it("preserves custom memory page sizes and treats unadmitted nested declarations as unknown", () => {
  const custom = parseWabtWat(
    '(module (memory 1 2 (pagesize 1)) (export "m" (memory 0)))',
  ).interface;
  expect(custom.entries[0]?.signature).toMatchObject({
    kind: "memory",
    page_size: "1",
  });
  const unknown = parseWabtWat(
    '(module (memory 1 (future-proposal 0)) (export "m" (memory 0)))',
  ).interface;
  expect(unknown.entries[0]?.signature).toBeNull();
});

it("refuses typed name expansion within the source WABT byte cap before retaining interface output", () => {
  const name = "x".repeat(6 * 1024 * 1024);
  expect(
    parseWabtWat(`(module (import "${name}" "f" (func)))`).interface,
  ).toMatchObject({
    state: "partial",
    entries: [],
    issues: [expect.stringMatching(/representation budget/u)],
  });
});

it("charges shared type signatures at every retained occurrence and preserves bounded partial facts", () => {
  const params = Array(1000).fill("i32").join(" ");
  const exports = Array.from(
    { length: 10000 },
    (_, i) => `(export "f${i}" (func 0))`,
  ).join(" ");
  const report = parseWabtWat(
    `(module (type (func (param ${params}))) (import "e" "f" (func (type 0))) ${exports})`,
  ).interface;
  expect(report.state).toBe("partial");
  expect(report.entries.length).toBeGreaterThan(1);
  expect(report.entries.length).toBeLessThan(10001);
  expect(report.entries[0]?.signature).toMatchObject({
    kind: "func",
    params: expect.any(Array),
  });
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(
    32 * 1024 * 1024,
  );
});
