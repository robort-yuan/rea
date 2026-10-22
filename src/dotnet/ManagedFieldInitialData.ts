import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import {
  admitManagedProjection,
  managedDecodeBudget,
} from "./ManagedDecodeBudget.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { metadataRowCursor, metadataToken } from "./ManagedMetadataHeaps.js";
import type {
  ManagedField,
  ManagedFieldStorage,
  ManagedType,
} from "./ManagedMemberInspectorCore.js";
import type { ManagedPeLayout } from "./ManagedPeReader.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";
import type { TypeMemberListFacts } from "./ManagedTypeMemberLists.js";
import type { ManagedTypeReferenceLookup } from "./ManagedTypeReferences.js";

type InitialData = NonNullable<ManagedField["initial_data"]>;
type Declaration = InitialData["declarations"][number];
interface DeclaredLayout {
  readonly rowOffset: number;
  readonly size: number;
  readonly packing: number;
}

/** Own FieldRVA rows and storage-size proofs; never infer lengths from neighboring RVAs. */
export const createManagedFieldDataReader = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  pe: ManagedPeLayout,
  memberLists: TypeMemberListFacts,
  types: readonly ManagedType[],
  typeReferences: ManagedTypeReferenceLookup,
  issues: ManagedParseIssue[],
): ((
  row: number,
  flags: number,
  storage: ManagedFieldStorage | null,
) => ManagedField["initial_data"]) => {
  const budget = managedDecodeBudget(layout);
  const declarations = new Map<number, Declaration[]>();
  const report = (
    detail: string,
    offset: number,
    scope = "metadata.FieldRVA",
  ) => {
    budget.reserve(512, offset);
    issues.push({ code: "invalid-row", scope, offset, detail });
  };
  const table = layout.table(29);
  for (let row = 1; row <= (table?.rowCount ?? 0); row++) {
    const cursor = metadataRowCursor(bytes, layout, 29, row);
    const rva = cursor.readUInt32();
    const field = cursor.readIndex(layout.tableIndexSize(4));
    if (field === 0 || field > (layout.table(4)?.rowCount ?? 0)) {
      report("FieldRVA names an out-of-range Field row", cursor.start + 4);
      continue;
    }
    budget.reserve(256, cursor.start);
    let rows = declarations.get(field);
    if (rows === undefined) {
      rows = [];
      declarations.set(field, rows);
    }
    rows.push({ row_offset: cursor.start, rva });
  }

  let storageLayouts: Map<number, DeclaredLayout[]> | undefined;
  let typesByToken: Map<string, ManagedType> | undefined;
  let genericTypes: Set<number> | undefined;
  const prepareLayouts = () => {
    if (storageLayouts !== undefined) return;
    storageLayouts = new Map();
    budget.reserve(types.length * 64 + 256, null);
    typesByToken = new Map(types.map((type) => [type.token, type]));
    genericTypes = new Set();
    for (let row = 1; row <= (layout.table(42)?.rowCount ?? 0); row++) {
      const cursor = metadataRowCursor(bytes, layout, 42, row);
      cursor.readUInt16();
      cursor.readUInt16();
      const owner = cursor.readIndex(layout.codedIndexSize("TypeOrMethodDef"));
      if ((owner & 1) === 0) {
        budget.reserve(64, cursor.start);
        genericTypes.add(Math.floor(owner / 2));
      }
    }
    for (let row = 1; row <= (layout.table(15)?.rowCount ?? 0); row++) {
      const cursor = metadataRowCursor(bytes, layout, 15, row);
      const packing = cursor.readUInt16();
      const size = cursor.readUInt32();
      const parent = cursor.readIndex(layout.tableIndexSize(2));
      if (parent === 0 || parent > (layout.table(2)?.rowCount ?? 0)) {
        report(
          "ClassLayout names an out-of-range TypeDef row",
          cursor.start + 6,
          "metadata.ClassLayout",
        );
        continue;
      }
      budget.reserve(256, cursor.start);
      let rows = storageLayouts.get(parent);
      if (rows === undefined) {
        rows = [];
        storageLayouts.set(parent, rows);
      }
      rows.push({ rowOffset: cursor.start, size, packing });
    }
  };

  const storageSize = (
    storage: ManagedFieldStorage | null,
  ): {
    readonly size: number;
    readonly basis: "primitive" | "class-layout";
    readonly layoutOffset: number | null;
  } | null => {
    if (storage === null) return null;
    if (storage.kind === "primitive")
      return { size: storage.size, basis: "primitive", layoutOffset: null };
    const encoded = storage.encodedType;
    // External types and TypeSpecs require additional layout/runtime knowledge.
    if ((encoded & 3) !== 0 || encoded === 0) return null;
    prepareLayouts();
    const row = Math.floor(encoded / 4);
    const type = typesByToken?.get(metadataToken(2, row));
    const layouts = storageLayouts?.get(row);
    const declared = layouts?.[0];
    if (type === undefined || declared === undefined || genericTypes?.has(row))
      return null;
    if (layouts?.length !== 1) {
      report(
        "Repeated ClassLayout rows leave field storage size ambiguous",
        declared.rowOffset,
        "metadata.ClassLayout",
      );
      return null;
    }
    const extent = memberLists.entries[row - 1]?.field;
    const kind = type.flags & 0x18;
    const base = type.extends_token;
    const reference =
      base?.startsWith("0x01") === true
        ? typeReferences(Number.parseInt(base.slice(4), 16))
        : null;
    if (
      (type.flags & 0x20) !== 0 ||
      (kind !== 0x08 && kind !== 0x10) ||
      reference?.namespace !== "System" ||
      reference.name !== "ValueType" ||
      !reference.scopeValid ||
      reference.enclosingRow !== null ||
      extent?.start.value === null ||
      extent?.start.value === undefined ||
      extent.end === null ||
      extent.start.value !== extent.end ||
      declared.size === 0 ||
      declared.size >= 0x10_0000 ||
      ![0, 1, 2, 4, 8, 16, 32, 64, 128].includes(declared.packing)
    )
      return null;
    // With no fields, the nonzero ClassSize is the complete storage extent.
    // For types with fields, ClassSize alone is only a minimum; do not guess.
    return {
      size: declared.size,
      basis: "class-layout",
      layoutOffset: declared.rowOffset,
    };
  };

  return (row, flags, storage) => {
    const rows = declarations.get(row) ?? [];
    const hasRva = (flags & 0x100) !== 0;
    if (rows.length === 0 && !hasRva) return null;
    const result: InitialData = {
      state: "unavailable",
      declarations: rows,
      file_offset: null,
      byte_length: null,
      size_basis: null,
      class_layout_row_offset: null,
      data_hex: null,
      data_sha256: null,
      limitation: null,
    };
    const scope = `metadata.FieldRVA:${metadataToken(4, row)}`;
    if (
      rows.length !== 1 ||
      !hasRva ||
      (flags & 0x10) === 0 ||
      (flags & 0x40) !== 0
    ) {
      result.limitation =
        "FieldRVA requires one declaration and a static, nonliteral field with HasFieldRVA.";
      report(
        result.limitation,
        rows[0]?.row_offset ?? metadataRowCursor(bytes, layout, 4, row).start,
        scope,
      );
      return admitManagedProjection(result, budget);
    }
    const declaration = rows[0];
    if (declaration === undefined)
      throw new TypeError("FieldRVA declaration is absent");
    try {
      result.file_offset = pe.rvaToOffset(declaration.rva, 1, scope);
      const size = storageSize(storage);
      if (size === null) {
        result.limitation =
          "Storage size is unknown: supported cases are unmodified fixed-width primitives and nongeneric local fieldless value types with one nonzero ClassLayout size.";
      } else {
        result.byte_length = size.size;
        result.size_basis = size.basis;
        result.class_layout_row_offset = size.layoutOffset;
        const offset = pe.rvaToOffset(declaration.rva, size.size, scope);
        // Account for the hex allocation and its projection before allocating it.
        budget.admitTransient(size.size * 4 + 256, offset);
        try {
          const data = bytes.subarray(offset, offset + size.size);
          result.data_hex = data.toString("hex");
          result.data_sha256 = budget.digest(data, "sha256");
          result.state = "present";
          return admitManagedProjection(result, budget);
        } finally {
          budget.releaseTransient();
        }
      }
    } catch (cause: unknown) {
      if (
        !(cause instanceof ManagedReaderFailure) ||
        cause.issue.code === "resource-limit"
      )
        throw cause;
      issues.push(cause.issue);
      result.limitation = cause.issue.detail;
    }
    return admitManagedProjection(result, budget);
  };
};
