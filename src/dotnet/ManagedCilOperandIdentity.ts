import { createHash } from "node:crypto";

import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import {
  resolvedSignatureSha256,
  resolvedSpecSha256,
  type ManagedMemberRef,
  type SignatureTypeName,
} from "./ManagedMemberInspectorCore.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import {
  metadataCodedToken,
  metadataRowCursor,
  metadataToken,
  metadataUserStringUnits,
  readMetadataBlob,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import { memberDeclaringTypeRowLookup } from "./ManagedMemberOwnership.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";
import type { TypeMemberListFacts } from "./ManagedTypeMemberLists.js";

/**
 * Framed nominal identity of one metadata token a CIL operand or a typed
 * exception clause carries, independent of build-local rows; null when REA
 * cannot name what the token references.
 */
export type CilOperandIdentity = (token: number) => Buffer | null;

const TYPE_REF = 0x01;
const TYPE_DEF = 0x02;
const FIELD = 0x04;
const METHOD_DEF = 0x06;
const MEMBER_REF = 0x0a;
const STAND_ALONE_SIG = 0x11;
const MODULE_REF = 0x1a;
const TYPE_SPEC = 0x1b;
const METHOD_SPEC = 0x2b;
const USER_STRING = 0x70;

/** Separates a kind tag, which never holds NUL, from the framed parts. */
const KIND_SEPARATOR = Buffer.from([0]);

/** Retained bookkeeping for one remembered token identity or blob digest. */
const CACHED_IDENTITY_BYTES = 128;

/**
 * Hash a kind tag, then each part behind its 32-bit length, so no identity's
 * preimage is another kind's and no part can run into the next. Each part is
 * charged to the representation budget before it is encoded and hashed:
 * distinct tokens can name overlapping heap items or share one long name, so
 * cached entries alone do not bound the bytes an inspection hashes.
 */
const framed = (
  layout: ManagedMetadataLayout,
  kind: string,
  ...parts: readonly (Buffer | string)[]
): Buffer => {
  const budget = managedDecodeBudget(layout);
  const hash = createHash("sha256").update(kind).update(KIND_SEPARATOR);
  for (const part of parts) {
    // A UTF-16 code unit encodes to at most three UTF-8 bytes.
    budget.reserve(
      typeof part === "string" ? part.length * 3 : part.length,
      null,
    );
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest();
};

/** Facts the owning inspection already parsed, which identities reuse. */
interface IdentitySources {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly memberLists: TypeMemberListFacts;
  /** The MemberRef owner's parsed rows, by token. */
  readonly memberRefs: ReadonlyMap<string, ManagedMemberRef>;
  readonly signatureTypeName: SignatureTypeName;
}

type RowCursor = ReturnType<typeof metadataRowCursor>;

/** The grammar a blob decodes with. */
type BlobForm = "type" | "instantiation" | "signature";

interface IdentityContext extends IdentitySources {
  /** The cached lookup, for tokens that name other tokens. */
  readonly identity: CilOperandIdentity;
  /**
   * The resolved digest of the blob the cursor's next column names, decoded
   * once per heap index and form because many rows can share one blob.
   */
  readonly resolvedBlob: (cursor: RowCursor, form: BlobForm) => Buffer | null;
}

const stringColumn = (context: IdentityContext, cursor: RowCursor): string =>
  readMetadataString(
    context.bytes,
    context.layout,
    cursor.readIndex(context.layout.stringIndexSize),
    context.layout.strings.size,
  );

const digestBytes = (digest: string | null): Buffer | null =>
  digest === null ? null : Buffer.from(digest, "hex");

const tokenNumber = (token: string): number =>
  Number.parseInt(token.slice(2), 16);

/** A TypeDef or TypeRef by its nominal name, as signatures name it. */
const typeIdentity = (
  context: IdentityContext,
  table: typeof TYPE_DEF | typeof TYPE_REF,
  row: number,
): Buffer | null => {
  const name = context.signatureTypeName(
    row * 4 + (table === TYPE_DEF ? 0 : 1),
  );
  return name === null ? null : framed(context.layout, "type", name);
};

const typeSpecIdentity = (
  context: IdentityContext,
  row: number,
): Buffer | null => {
  const spec = context.resolvedBlob(
    metadataRowCursor(context.bytes, context.layout, TYPE_SPEC, row),
    "type",
  );
  return spec === null ? null : framed(context.layout, "typespec", spec);
};

/** A field or method definition, named after its declaring TypeDef. */
const definitionIdentity = (
  context: IdentityContext,
  table: typeof FIELD | typeof METHOD_DEF,
  row: number,
): Buffer | null => {
  const owner = memberDeclaringTypeRowLookup(
    context.bytes,
    context.layout,
    table,
    context.memberLists,
  )(row);
  const parent = owner === 0 ? null : typeIdentity(context, TYPE_DEF, owner);
  if (parent === null) return null;
  const cursor = metadataRowCursor(context.bytes, context.layout, table, row);
  if (table === METHOD_DEF) {
    cursor.readUInt32();
    cursor.readUInt16();
  }
  cursor.readUInt16();
  const name = stringColumn(context, cursor);
  const signature = context.resolvedBlob(cursor, "signature");
  return signature === null
    ? null
    : framed(context.layout, "member", parent, name, signature);
};

/** A member reference, named after its parent's identity. */
const memberRefIdentity = (
  context: IdentityContext,
  row: number,
): Buffer | null => {
  const reference = context.memberRefs.get(metadataToken(MEMBER_REF, row));
  if (reference?.parent_token == null) return null;
  const signature = digestBytes(reference.signature.resolved_sha256);
  const parent = context.identity(tokenNumber(reference.parent_token));
  return signature === null || parent === null
    ? null
    : framed(context.layout, "member", parent, reference.name, signature);
};

const moduleRefIdentity = (context: IdentityContext, row: number): Buffer =>
  framed(
    context.layout,
    "moduleref",
    stringColumn(
      context,
      metadataRowCursor(context.bytes, context.layout, MODULE_REF, row),
    ),
  );

const methodSpecIdentity = (
  context: IdentityContext,
  row: number,
): Buffer | null => {
  const cursor = metadataRowCursor(
    context.bytes,
    context.layout,
    METHOD_SPEC,
    row,
  );
  const method = metadataCodedToken(
    cursor.readIndex(context.layout.codedIndexSize("MethodDefOrRef")),
    1,
    [METHOD_DEF, MEMBER_REF],
    context.layout.rowCounts,
  );
  const instantiation = context.resolvedBlob(cursor, "instantiation");
  const generic =
    method === null ? null : context.identity(tokenNumber(method));
  return generic === null || instantiation === null
    ? null
    : framed(context.layout, "methodspec", generic, instantiation);
};

const standAloneSigIdentity = (
  context: IdentityContext,
  row: number,
): Buffer | null => {
  const signature = context.resolvedBlob(
    metadataRowCursor(context.bytes, context.layout, STAND_ALONE_SIG, row),
    "signature",
  );
  return signature === null
    ? null
    : framed(context.layout, "standalonesig", signature);
};

const ROW_IDENTITIES: ReadonlyMap<
  number,
  (context: IdentityContext, row: number) => Buffer | null
> = new Map([
  [TYPE_REF, (context, row) => typeIdentity(context, TYPE_REF, row)],
  [TYPE_DEF, (context, row) => typeIdentity(context, TYPE_DEF, row)],
  [TYPE_SPEC, typeSpecIdentity],
  [FIELD, (context, row) => definitionIdentity(context, FIELD, row)],
  [METHOD_DEF, (context, row) => definitionIdentity(context, METHOD_DEF, row)],
  [MEMBER_REF, memberRefIdentity],
  [MODULE_REF, moduleRefIdentity],
  [METHOD_SPEC, methodSpecIdentity],
  [STAND_ALONE_SIG, standAloneSigIdentity],
]);

const resolve = (
  context: IdentityContext,
  table: number,
  row: number,
): Buffer | null => {
  // A user string is a #US heap offset, not a table row.
  if (table === USER_STRING)
    return framed(
      context.layout,
      "string",
      metadataUserStringUnits(
        context.bytes,
        context.layout,
        metadataToken(table, row),
      ),
    );
  const named = ROW_IDENTITIES.get(table);
  return named === undefined ||
    row < 1 ||
    row > (context.layout.rowCounts[table] ?? 0)
    ? null
    : named(context, row);
};

/**
 * Remember each key's value for one inspection, charging each retained entry
 * to the representation budget. A reader failure other than that budget
 * leaves the key without an identity.
 */
const remembered = <Key>(
  layout: ManagedMetadataLayout,
): ((key: Key, resolveKey: () => Buffer | null) => Buffer | null) => {
  const values = new Map<Key, Buffer | null>();
  return (key, resolveKey) => {
    const cached = values.get(key);
    if (cached !== undefined) return cached;
    managedDecodeBudget(layout).reserve(CACHED_IDENTITY_BYTES, null);
    let value: Buffer | null;
    try {
      value = resolveKey();
    } catch (cause: unknown) {
      if (
        !(cause instanceof ManagedReaderFailure) ||
        cause.issue.code === "resource-limit"
      )
        throw cause;
      value = null;
    }
    values.set(key, value);
    return value;
  };
};

/**
 * Name each token by what it references rather than by its row: a TypeDef or
 * TypeRef by its framed nominal type name, so the two compare alike as in
 * signatures; a TypeSpec by its resolved blob; a field, method, or member
 * reference by its owner's identity, name, and resolved signature; a
 * MethodSpec by its method and resolved instantiation; a StandAloneSig by its
 * resolved signature; and a user string by its UTF-16 code units. A row
 * outside its table, an unreadable row, or a value the existing owners cannot
 * name, such as a TypeSpec nested in a TypeSpec or an unsupported signature,
 * has no identity. Each token, and each blob in each form, is resolved once
 * per inspection, so rows that share a blob share its decoding. Resolution
 * failures stay unknown rather than becoming coverage issues of their own.
 */
export const managedCilOperandIdentities = (
  sources: IdentitySources,
): CilOperandIdentity => {
  const tokens = remembered<number>(sources.layout);
  const blobs = remembered<string>(sources.layout);
  const identity: CilOperandIdentity = (token) =>
    tokens(token, () =>
      resolve(context, Math.floor(token / 0x01_00_00_00), token & 0xff_ffff),
    );
  const resolvedBlob = (cursor: RowCursor, form: BlobForm): Buffer | null => {
    const index = cursor.readIndex(sources.layout.blobIndexSize);
    return blobs(`${form}:${String(index)}`, () => {
      const blob = readMetadataBlob(
        sources.bytes,
        sources.layout,
        index,
        sources.layout.blob.size,
      );
      // Blobs at distinct indexes can overlap, so each one's hashed bytes
      // are charged as the parts of an identity are.
      managedDecodeBudget(sources.layout).reserve(blob.length, null);
      return digestBytes(
        form === "signature"
          ? resolvedSignatureSha256(
              sources.layout,
              blob,
              sources.signatureTypeName,
            )
          : resolvedSpecSha256(
              sources.layout,
              blob,
              form,
              sources.signatureTypeName,
            ),
      );
    });
  };
  const context: IdentityContext = { ...sources, identity, resolvedBlob };
  return identity;
};
