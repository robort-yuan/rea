import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";
import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import { createManagedFieldDataReader } from "./ManagedFieldInitialData.js";
import { parseTypes, typeRanges } from "./ManagedMemberInspectorCore.js";
import { readManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { readManagedPeLayout } from "./ManagedPeReader.js";
import { readTypeMemberListFacts } from "./ManagedTypeMemberLists.js";

const bytes32 = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const inspect = (options: Parameters<typeof buildManagedPeFixture>[0]) => {
  const bytes = buildManagedPeFixture(options);
  return inspectManagedMembersBytes(bytes, managedPeFixtureTarget(bytes));
};
const blobOptions = {
  additionalEmptyTypes: 1,
  extendsRaw: (2 << 2) | 1,
  typeReferences: [{ namespace: "System", name: "ValueType" }],
  typeFlags: 0x0010_0111,
  fieldSignature: Buffer.from([0x06, 0x11, 4]),
  classLayouts: [{ parent: 1, size: 32, packing: 1 }],
  fieldRva: { data: bytes32 },
};

describe("managed FieldRVA initialization data", () => {
  it("distinguishes a field with no RVA declaration from unexamined old evidence", () => {
    const result = inspect({});
    expect(result.fields[0]?.initial_data).toBeNull();
    const old = structuredClone(result);
    Reflect.deleteProperty(old.fields[0] ?? {}, "initial_data");
    expect(managedMemberInspectionSchema.safeParse(old).success).toBe(false);
  });

  it.each([
    [2, 1],
    [3, 2],
    [4, 1],
    [5, 1],
    [6, 2],
    [7, 2],
    [8, 4],
    [9, 4],
    [10, 8],
    [11, 8],
    [12, 4],
    [13, 8],
  ])(
    "reads primitive element %i using its exact %i-byte storage extent",
    (element, size) => {
      const result = inspect({
        fieldSignature: Buffer.from([6, element]),
        fieldRva: { data: bytes32 },
      });
      expect(result.coverage).toEqual({ state: "complete", issues: [] });
      expect(result.fields[0]?.initial_data).toMatchObject({
        state: "present",
        byte_length: size,
        size_basis: "primitive",
        class_layout_row_offset: null,
        data_hex: bytes32.subarray(0, size).toString("hex"),
        data_sha256: createHash("sha256")
          .update(bytes32.subarray(0, size))
          .digest("hex"),
        limitation: null,
      });
    },
  );

  it("uses a local fieldless value type's ClassLayout even outside the selection", () => {
    const bytes = buildManagedPeFixture(blobOptions);
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
      { typeNames: ["Fixture.Program"] },
    );
    const data = result.fields[0]?.initial_data;
    expect(result.types).toHaveLength(1);
    expect(result.coverage).toEqual({ state: "complete", issues: [] });
    expect(data).toMatchObject({
      state: "present",
      byte_length: 32,
      size_basis: "class-layout",
      data_hex: bytes32.toString("hex"),
    });
    expect(data?.class_layout_row_offset).toBeGreaterThan(0);
    expect(
      bytes.subarray(data?.file_offset ?? 0, (data?.file_offset ?? 0) + 32),
    ).toEqual(bytes32);
    expect(data?.declarations).toHaveLength(1);
  });

  it.each([
    Buffer.from([6, 0x18]),
    Buffer.from([6, 0x11, 5]),
    Buffer.from([6, 0x1d, 5]),
  ])(
    "retains the mapped start without guessing unsupported storage length %j",
    (signature) => {
      const result = inspect({
        fieldSignature: signature,
        fieldRva: { data: bytes32 },
      });
      expect(result.coverage.state).toBe("partial");
      expect(result.fields[0]?.initial_data).toMatchObject({
        state: "unavailable",
        byte_length: null,
        data_hex: null,
        data_sha256: null,
      });
      expect(result.fields[0]?.initial_data?.file_offset).toBeGreaterThan(0);
    },
  );

  it("does not treat ClassSize as exact when the value type has fields", () => {
    const result = inspect({
      ...blobOptions,
      fieldSignature: Buffer.from([6, 0x11, 8]),
      classLayouts: [{ parent: 2, size: 32 }],
    });
    expect(result.fields[0]?.initial_data).toMatchObject({
      state: "unavailable",
      byte_length: null,
      data_hex: null,
    });
  });
});

describe("managed FieldRVA malformed declarations and capacity", () => {
  it("preserves duplicate RVA declarations without choosing one", () => {
    const result = inspect({
      fieldRva: { data: bytes32, declarations: [{}, { rva: 0x2345 }] },
    });
    expect(result.coverage.state).toBe("partial");
    expect(result.fields[0]?.initial_data).toMatchObject({
      state: "unavailable",
      file_offset: null,
      data_hex: null,
      declarations: [{}, { rva: 0x2345 }],
    });
    expect(result.coverage.issues).toContainEqual(
      expect.objectContaining({ code: "invalid-row" }),
    );
  });

  it.each([0x0001, 0x0011, 0x0141])(
    "rejects contradictory field flags %i",
    (flags) => {
      const result = inspect({
        fieldFlags: flags,
        fieldRva: { data: bytes32 },
      });
      expect(result.fields[0]?.initial_data).toMatchObject({
        state: "unavailable",
        data_hex: null,
      });
      expect(result.coverage.issues).toContainEqual(
        expect.objectContaining({ code: "invalid-row" }),
      );
    },
  );

  it("keeps a missing FieldRVA row unknown when HasFieldRVA is set", () => {
    const result = inspect({ fieldRva: { data: bytes32, declarations: [] } });
    expect(result.fields[0]?.initial_data).toMatchObject({
      state: "unavailable",
      declarations: [],
      data_hex: null,
    });
  });

  it("reports an invalid Field row rather than dropping the declaration silently", () => {
    const result = inspect({
      fieldRva: { data: bytes32, declarations: [{ field: 2 }] },
    });
    expect(result.coverage.issues).toContainEqual(
      expect.objectContaining({
        detail: "FieldRVA names an out-of-range Field row",
      }),
    );
  });

  it.each([0, 0xffff_ffff, 0x2dff])(
    "rejects unmapped or partially file-backed RVA %i",
    (rva) => {
      const result = inspect({
        fieldRva: { data: bytes32, declarations: [{ rva }] },
      });
      expect(result.fields[0]?.initial_data).toMatchObject({
        state: "unavailable",
        data_hex: null,
        data_sha256: null,
      });
      expect(result.coverage.state).toBe("partial");
    },
  );

  it("does not read raw padding outside the section's virtual size", () => {
    const result = inspect({
      virtualSectionSize: 0x810,
      fieldRva: { data: bytes32 },
    });
    expect(result.fields[0]?.initial_data).toMatchObject({
      state: "unavailable",
      file_offset: null,
      data_hex: null,
    });
  });

  it("leaves conflicting ClassLayout sizes unresolved", () => {
    const result = inspect({
      ...blobOptions,
      classLayouts: [
        { parent: 1, size: 32 },
        { parent: 1, size: 64 },
      ],
    });
    expect(result.fields[0]?.initial_data).toMatchObject({
      state: "unavailable",
      byte_length: null,
    });
    expect(result.coverage.issues).toContainEqual(
      expect.objectContaining({ scope: "metadata.ClassLayout" }),
    );
  });

  it("enforces representation capacity before allocating the hex string", () => {
    const bytes = buildManagedPeFixture({
      ...blobOptions,
      classLayouts: [{ parent: 1, size: 8192 }],
      fieldRva: { data: Buffer.alloc(8192) },
    });
    const pe = readManagedPeLayout(bytes);
    const cli = pe.cli;
    if (cli === null) throw new Error("Fixture has no CLI metadata");
    const layout = readManagedMetadataLayout(
      bytes,
      pe.rvaToOffset(cli.metadata.rva, cli.metadata.size, "test"),
      cli.metadata.size,
    );
    const lists = readTypeMemberListFacts(bytes, layout);
    const ranges = typeRanges(bytes, layout, [], lists);
    const types = parseTypes(bytes, layout, ranges);
    const read = createManagedFieldDataReader(
      bytes,
      layout,
      pe,
      lists,
      types.types,
      () => ({
        namespace: "System",
        name: "ValueType",
        enclosingRow: null,
        scopeValid: true,
      }),
      [],
    );
    managedDecodeBudget(layout).reserve(64 * 1024 * 1024 - 16 * 1024, null);
    expect(() =>
      read(1, 0x111, { kind: "value-type", encodedType: 4 }),
    ).toThrow(
      expect.objectContaining({
        issue: expect.objectContaining({ code: "resource-limit" }),
      }),
    );
  });
});
