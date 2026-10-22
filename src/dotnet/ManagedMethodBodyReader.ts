import { createHash } from "node:crypto";

import {
  admitManagedProjection,
  type ManagedDecodeBudget,
} from "./ManagedDecodeBudget.js";
import type { CilOperandIdentity } from "./ManagedCilOperandIdentity.js";
import type { ManagedPeLayout } from "./ManagedPeReader.js";
import type {
  ManagedExceptionRegion,
  ManagedMethodBody,
  ParsedInstruction,
} from "./ManagedMemberInspectorCore.js";
import {
  decodeInstructions,
  parseExceptionRegions,
} from "./ManagedMemberInstructionDecoder.js";
import { validateExceptionRegionRanges } from "./ManagedExceptionRegionValidation.js";
import { sha256Bytes } from "./ManagedMetadataHeaps.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";

const bodyStatus = (
  decodedIssue: string | null,
  truncatedInstructions: number,
  exceptionRegions: ReturnType<typeof parseExceptionRegions> | null,
): "malformed" | "partial" | "present" => {
  if (decodedIssue !== null || exceptionRegions?.status === "malformed")
    return "malformed";
  if (truncatedInstructions > 0) return "partial";
  return "present";
};

interface MethodBodyHeader {
  readonly format: "tiny" | "fat";
  readonly size: number;
  readonly flags: number;
  readonly maxStack: number;
  readonly ilSize: number;
  readonly localSig: number;
}

const readMethodBodyHeader = (
  bytes: Buffer,
  offset: number,
): MethodBodyHeader => {
  const first = bytes.readUInt8(offset);
  if ((first & 3) === 2)
    return {
      format: "tiny",
      size: 1,
      flags: 0,
      maxStack: 8,
      ilSize: first >> 2,
      localSig: 0,
    };
  if ((first & 3) !== 3) throw new RangeError("Unsupported method body header");
  if (offset > bytes.length - 12)
    throw new RangeError("Fat method body header leaves artifact");
  const flagsAndSize = bytes.readUInt16LE(offset);
  const headerDwords = flagsAndSize >>> 12;
  if (headerDwords < 3)
    throw new RangeError("Fat method body header is smaller than 12 bytes");
  const size = headerDwords * 4;
  if (offset > bytes.length - size)
    throw new RangeError("Method body header leaves artifact");
  return {
    format: "fat",
    size,
    flags: flagsAndSize & 0x0fff,
    maxStack: bytes.readUInt16LE(offset + 2),
    ilSize: bytes.readUInt32LE(offset + 4),
    localSig: bytes.readUInt32LE(offset + 8),
  };
};

/** Operand kinds whose value is a 4-byte metadata token. */
const TOKEN_OPERAND_KINDS: ReadonlySet<ParsedInstruction["operandKind"]> =
  new Set(["method", "field", "type", "string", "signature", "token"]);

/**
 * Digest the raw CIL with each token operand's four bytes replaced by its
 * 32-byte nominal identity. An opcode fixes its operand's form, so the
 * substituted stream still parses into exactly one instruction sequence, and
 * no raw bytes can stand in for an identity. Null when any operand has none.
 */
const nominalIlSha256 = (
  il: Buffer,
  instructions: readonly ParsedInstruction[],
  identity: CilOperandIdentity,
): string | null => {
  const hash = createHash("sha256");
  let copied = 0;
  for (const { offset, operandKind } of instructions) {
    if (!TOKEN_OPERAND_KINDS.has(operandKind)) continue;
    // A token operand directly follows its one- or two-byte (0xfe) opcode.
    const operandOffset = offset + (il[offset] === 0xfe ? 2 : 1);
    const named = identity(il.readUInt32LE(operandOffset));
    if (named === null) return null;
    hash.update(il.subarray(copied, operandOffset)).update(named);
    copied = operandOffset + 4;
  }
  return hash.update(il.subarray(copied)).digest("hex");
};

const classIdentity = (
  region: ManagedExceptionRegion,
  identity: CilOperandIdentity | undefined,
): string | null =>
  region.class_token === null || identity === undefined
    ? null
    : (identity(Number.parseInt(region.class_token.slice(2), 16))?.toString(
        "hex",
      ) ?? null);

/**
 * Name a body's token operands and its typed clauses' classes. Only a
 * completely decoded body has a nominal digest; clause classes are named
 * whenever identities are available, like their raw tokens.
 */
const nominalOperands = ({
  il,
  instructions,
  regions,
  complete,
  identity,
}: {
  readonly il: Buffer;
  readonly instructions: readonly ParsedInstruction[];
  readonly regions: readonly ManagedExceptionRegion[];
  readonly complete: boolean;
  readonly identity: CilOperandIdentity | undefined;
}): {
  readonly ilSha256: string | null;
  readonly regions: ManagedExceptionRegion[];
} => ({
  ilSha256:
    complete && identity !== undefined
      ? nominalIlSha256(il, instructions, identity)
      : null,
  regions: regions.map((region) => ({
    ...region,
    class_identity_sha256: classIdentity(region, identity),
  })),
});

/** Decode admitted managed CIL, retaining unavailable implementation metadata as partial. */
export const methodBody = (
  bytes: Buffer,
  pe: ManagedPeLayout,
  rva: number,
  implementation: { readonly implFlags: number; readonly flags: number } = {
    implFlags: 0,
    flags: 0,
  },
  {
    budget,
    operandIdentity,
  }: {
    readonly budget?: ManagedDecodeBudget;
    /** Nominal operand identities; without them no nominal digest is computed. */
    readonly operandIdentity?: CilOperandIdentity;
  } = {},
): {
  readonly body: ManagedMethodBody;
  /**
   * Whether every CIL instruction was decoded, independent of exception-region
   * validity. A body with no CIL, absent or native, has nothing left unscanned.
   */
  readonly scanned: boolean;
} => {
  // Without CIL there is nothing left unscanned.
  if (rva === 0)
    return { body: emptyMethodBody(rva, "absent", null), scanned: true };
  const native =
    (implementation.implFlags & 7) !== 0 ||
    (implementation.flags & 0x2000) !== 0;
  if (native) {
    const issue =
      "CIL decoding is unavailable for native, runtime, unmanaged, or P/Invoke implementations";
    return { body: emptyMethodBody(rva, "partial", issue), scanned: true };
  }
  try {
    const offset = pe.rvaToOffset(rva, 1, "method.body");
    const methodExtent = pe.rvaAvailableBytes(rva, "method.body");
    const header = readMethodBodyHeader(bytes, offset);
    if (
      header.size > methodExtent ||
      header.ilSize > methodExtent - header.size
    )
      throw new RangeError("Method body leaves file-backed PE section data");
    const ilOffset = offset + header.size;
    if (ilOffset > bytes.length - header.ilSize)
      throw new RangeError("Method IL bytes leave artifact");
    const il = bytes.subarray(ilOffset, ilOffset + header.ilSize);
    // Bound the actual instruction records before allocating them. One raw
    // byte is only an upper bound on count; wide operands do not create a
    // separate instruction for every byte. Retained output is charged below.
    const decoded = decodeInstructions(
      il,
      budget === undefined
        ? undefined
        : (start) => budget.admitTransient(256, ilOffset + start),
    );
    const opcodeCounts: Record<string, number> = {};
    for (const instruction of decoded.parsed)
      opcodeCounts[instruction.opcode] =
        (opcodeCounts[instruction.opcode] ?? 0) + 1;
    // Keep every decoded instruction: implicit constants such as ldc.i4.N
    // are encoded in opcodes whose operand kind is "none".
    const anchors = decoded.parsed.map((instruction) => ({
      il_offset: instruction.offset,
      opcode: instruction.opcode,
      operand_kind: instruction.operandKind,
      operand: instruction.operand,
    }));
    const normalized = Buffer.from(
      JSON.stringify(
        decoded.parsed.map(({ opcode, operandKind, operand }) => [
          opcode,
          operandKind,
          operand,
        ]),
      ),
      "utf8",
    );
    const methodEnd = ilOffset + header.ilSize;
    const sectionOffset = Math.ceil(methodEnd / 4) * 4;
    const exceptionRegions =
      header.format === "fat" && (header.flags & 8) !== 0
        ? validateExceptionRegionRanges(
            parseExceptionRegions(
              bytes,
              sectionOffset,
              offset + methodExtent,
              budget,
            ),
            header.ilSize,
            decoded.instructionStarts,
          )
        : null;
    const status = bodyStatus(
      decoded.issue,
      decoded.truncated,
      exceptionRegions,
    );
    const nominal = nominalOperands({
      il,
      instructions: decoded.parsed,
      regions: exceptionRegions?.regions ?? [],
      complete: status === "present",
      identity: operandIdentity,
    });
    const body: ManagedMethodBody = {
      status,
      header_format: header.format,
      rva,
      file_offset: offset,
      max_stack: header.maxStack,
      init_locals: (header.flags & 0x10) !== 0,
      local_var_sig_token:
        header.localSig === 0
          ? null
          : `0x${header.localSig.toString(16).padStart(8, "0")}`,
      il_size: header.ilSize,
      il_sha256: sha256Bytes(il),
      normalized_il_sha256:
        status === "present" ? sha256Bytes(normalized) : null,
      nominal_il_sha256: nominal.ilSha256,
      instruction_count: decoded.count,
      decoded_instruction_count: decoded.parsed.length,
      truncated_instructions: decoded.truncated,
      opcode_counts: opcodeCounts,
      anchors,
      exception_regions: nominal.regions,
      issue:
        decoded.issue ??
        (exceptionRegions?.status === "malformed"
          ? exceptionRegions.issue
          : null) ??
        (decoded.truncated > 0
          ? "Instruction decoding stopped before the end of the method body"
          : null),
    };
    return {
      body: budget === undefined ? body : admitManagedProjection(body, budget),
      scanned: decoded.issue === null && decoded.truncated === 0,
    };
  } catch (cause: unknown) {
    if (
      cause instanceof ManagedReaderFailure &&
      cause.issue.code === "resource-limit"
    )
      throw cause;
    if (
      !(cause instanceof ManagedReaderFailure) &&
      !(cause instanceof RangeError)
    )
      throw cause;
    return {
      body: emptyMethodBody(
        rva,
        "malformed",
        cause instanceof Error ? cause.message : "Method body parse failed",
      ),
      scanned: false,
    };
  } finally {
    // IL and exception-section bookkeeping coexist until the body is built.
    budget?.releaseTransient();
  }
};

const emptyMethodBody = (
  rva: number,
  status: "absent" | "malformed" | "partial",
  issue: string | null,
): ManagedMethodBody => ({
  status,
  header_format: status === "absent" ? "none" : "unknown",
  rva,
  file_offset: null,
  max_stack: null,
  init_locals: null,
  local_var_sig_token: null,
  il_size: 0,
  il_sha256: null,
  normalized_il_sha256: null,
  nominal_il_sha256: null,
  instruction_count: 0,
  decoded_instruction_count: 0,
  truncated_instructions: 0,
  opcode_counts: {},
  anchors: [],
  exception_regions: [],
  issue,
});
