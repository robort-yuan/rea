import type {
  MachoEncryptedRange,
  MachoEncryptionCommand,
  MachoEncryptionFacts,
  MachoSliceEncryption,
} from "../../domain/apple/machoEncryption.js";
import { validateFatSliceIdentity } from "../../domain/apple/machoContainer.js";
import {
  frameLoadCommands,
  readMachoContainer,
  readSliceCommandTable,
  type MachoLoadCommand,
  type MachoReadIssue,
  type MachoSliceHeader,
  type ReadAt,
} from "./MachoLoadCommandReader.js";

const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_ENCRYPTION_INFO = 0x21;
const LC_ENCRYPTION_INFO_64 = 0x2c;
// loader.h: encryption_info_command is five 32-bit words; the 64-bit form adds `pad`.
const ENCRYPTION_COMMAND_SIZE = { 32: 20, 64: 24 } as const;
// loader.h section types whose bytes occupy no file range.
const ZEROFILL_SECTION_TYPES = new Set([0x1, 0xc, 0x12]);

/**
 * Read each slice's `LC_ENCRYPTION_INFO(_64)` status without reading code.
 * One slice's defect never hides another slice's status.
 */
export const readMachoEncryption = async (
  readAt: ReadAt,
  size: number,
): Promise<MachoEncryptionFacts> => {
  const container = await readMachoContainer(readAt, size);
  if (container.kind === "not-mach-o") return { status: "not-mach-o" };
  if (container.kind === "issue")
    return { status: container.status, reason: container.reason };
  if (container.kind === "thin")
    return {
      status: "parsed",
      slices: [await readSlice(readAt, { offset: 0, size, fat: null })],
    };
  const slices: MachoSliceEncryption[] = [];
  for (const [index, declaration] of container.slices.entries()) {
    const rangeIssue = container.rangeIssues[index] ?? null;
    slices.push(
      rangeIssue === null
        ? await readSlice(readAt, {
            offset: declaration.offset,
            size: declaration.size,
            fat: declaration,
          })
        : unread(
            declaration,
            rangeIssue.category === "unsupported" ? "unknown" : "malformed",
            rangeIssue.reason,
          ),
    );
  }
  return { status: "parsed", slices };
};

type FatDeclaration = Parameters<typeof validateFatSliceIdentity>[0];

const unread = (
  declaration: FatDeclaration,
  status: "malformed" | "unknown",
  reason: string,
): MachoSliceEncryption => ({
  architecture: null,
  cpu_type: declaration.cpuType,
  cpu_subtype: declaration.cpuSubtype,
  container_file_offset: declaration.offset,
  size: declaration.size,
  status,
  reason,
  commands: [],
  range: null,
});

const readSlice = async (
  readAt: ReadAt,
  slice: {
    readonly offset: number;
    readonly size: number;
    readonly fat: FatDeclaration | null;
  },
): Promise<MachoSliceEncryption> => {
  const table = await readSliceCommandTable(readAt, slice.offset, slice.size);
  const base = {
    architecture: null,
    cpu_type: table.header?.cpuType ?? slice.fat?.cpuType ?? null,
    cpu_subtype: table.header?.cpuSubtype ?? slice.fat?.cpuSubtype ?? null,
    container_file_offset: slice.offset,
    size: slice.size,
  };
  // Only encryption and segment commands are retained; the rest are framed
  // and dropped so a large table of small commands stays one buffer.
  const commands: MachoEncryptionCommand[] = [];
  const segments: MachoLoadCommand[] = [];
  // Commands seen before a failure stay as partial facts; an incomplete walk
  // can never prove the command is absent.
  const incomplete = ({
    status,
    reason,
  }: MachoReadIssue): MachoSliceEncryption => ({
    ...base,
    status: status === "unsupported" ? "unknown" : "malformed",
    reason,
    commands,
    range: null,
  });
  if (table.status !== "read") return incomplete(table);
  const { header } = table;
  const framed = frameLoadCommands(table, (command) => {
    if (isEncryptionCommand(command.command))
      commands.push(decodeEncryptionCommand(command));
    else if (
      command.command === LC_SEGMENT ||
      command.command === LC_SEGMENT_64
    )
      segments.push(command);
  });
  if (framed.status !== "framed") return incomplete(framed);
  const identityIssue =
    slice.fat === null
      ? null
      : validateFatSliceIdentity(slice.fat, {
          cpuType: header.cpuType,
          cpuSubtype: header.cpuSubtype,
        });
  if (identityIssue !== null)
    return {
      ...base,
      status: "malformed",
      reason: identityIssue,
      commands,
      range: null,
    };
  const outcome = classify(commands, header, slice.size);
  if (outcome.status !== "valid")
    return { ...base, ...outcome, commands, range: null };
  return {
    ...base,
    status: outcome.command.cryptid === 0 ? "not-encrypted" : "encrypted",
    reason: null,
    commands,
    range: encryptedRange(outcome.command, header, segments, slice.offset),
  };
};

const isEncryptionCommand = (command: number): boolean =>
  command === LC_ENCRYPTION_INFO || command === LC_ENCRYPTION_INFO_64;

const decodeEncryptionCommand = ({
  command,
  body,
  index,
}: MachoLoadCommand): MachoEncryptionCommand => {
  const view = viewOf(body);
  const word = (at: number): number | null =>
    body.byteLength >= at + 4 ? view.getUint32(at, true) : null;
  const wide = command === LC_ENCRYPTION_INFO_64;
  return {
    kind: wide ? "LC_ENCRYPTION_INFO_64" : "LC_ENCRYPTION_INFO",
    index,
    cmdsize: body.byteLength,
    cryptoff: word(8),
    cryptsize: word(12),
    cryptid: word(16),
    pad: wide ? word(20) : null,
  };
};

type Classification =
  | {
      readonly status: "valid";
      readonly command: MachoEncryptionCommand & {
        readonly cryptoff: number;
        readonly cryptsize: number;
        readonly cryptid: number;
      };
    }
  | { readonly status: "absent"; readonly reason: null }
  | { readonly status: "malformed"; readonly reason: string };

const classify = (
  commands: readonly MachoEncryptionCommand[],
  header: MachoSliceHeader,
  sliceSize: number,
): Classification => {
  if (commands.length === 0) return { status: "absent", reason: null };
  const [command] = commands;
  if (command === undefined || commands.length > 1)
    return {
      status: "malformed",
      reason: `slice has ${commands.length} encryption load commands`,
    };
  const width = header.wide ? 64 : 32;
  const expectedKind = header.wide
    ? "LC_ENCRYPTION_INFO_64"
    : "LC_ENCRYPTION_INFO";
  if (command.kind !== expectedKind)
    return {
      status: "malformed",
      reason: `load command ${command.index} ${command.kind} appears in a ${width}-bit image`,
    };
  const expectedSize = ENCRYPTION_COMMAND_SIZE[width];
  const { cryptoff, cryptsize, cryptid } = command;
  if (
    command.cmdsize !== expectedSize ||
    cryptoff === null ||
    cryptsize === null ||
    cryptid === null
  )
    return {
      status: "malformed",
      reason: `load command ${command.index} ${command.kind} has cmdsize ${command.cmdsize}, expected ${expectedSize}`,
    };
  // Both fields are 32-bit, so their sum is a safe integer.
  if (cryptoff + cryptsize > sliceSize)
    return {
      status: "malformed",
      reason: `load command ${command.index} encrypted range ends at ${cryptoff + cryptsize}, beyond the ${sliceSize}-byte slice`,
    };
  return {
    status: "valid",
    command: { ...command, cryptoff, cryptsize, cryptid },
  };
};

const encryptedRange = (
  command: {
    readonly cryptoff: number;
    readonly cryptsize: number;
    readonly cryptid: number;
  },
  header: MachoSliceHeader,
  segmentCommands: readonly MachoLoadCommand[],
  containerOffset: number,
): MachoEncryptedRange => {
  const start = command.cryptoff;
  const end = command.cryptoff + command.cryptsize;
  return {
    content: command.cryptid === 0 ? "plaintext" : "ciphertext",
    slice_start: start,
    slice_end: end,
    container_start: containerOffset + start,
    container_end: containerOffset + end,
    mapping: mapRange(start, end, header, segmentCommands),
  };
};

interface SegmentFacts {
  readonly name: string;
  readonly vmAddress: bigint;
  readonly fileOffset: number;
  readonly fileSize: number;
  readonly sections: readonly {
    readonly name: string;
    readonly offset: number;
    readonly size: number;
    readonly zerofill: boolean;
  }[];
}

const mapRange = (
  start: number,
  end: number,
  header: MachoSliceHeader,
  segmentCommands: readonly MachoLoadCommand[],
): MachoEncryptedRange["mapping"] => {
  const segments: SegmentFacts[] = [];
  for (const command of segmentCommands) {
    if ((command.command === LC_SEGMENT_64) !== header.wide)
      return {
        status: "unknown",
        reason: `load command ${command.index} ${command.command === LC_SEGMENT_64 ? "LC_SEGMENT_64" : "LC_SEGMENT"} appears in a ${header.wide ? 64 : 32}-bit image`,
      };
    const segment = decodeSegment(command);
    if (typeof segment === "string")
      return { status: "unknown", reason: segment };
    segments.push(segment);
  }
  const fileBacked = segments
    .filter(({ fileSize }) => fileSize > 0)
    .sort((left, right) => left.fileOffset - right.fileOffset);
  const fragments: Extract<
    MachoEncryptedRange["mapping"],
    { status: "mapped" }
  >["fragments"] = [];
  let cursor = start;
  for (const segment of fileBacked) {
    // Overlapping segments never report the same byte twice.
    const from = Math.max(cursor, segment.fileOffset);
    const to = Math.min(end, segment.fileOffset + segment.fileSize);
    if (from >= to) continue;
    if (from > cursor) fragments.push(unmapped(cursor, from));
    fragments.push({
      slice_start: from,
      slice_end: to,
      segment: segment.name,
      vm_start: hex(segment.vmAddress + BigInt(from - segment.fileOffset)),
      vm_end: hex(segment.vmAddress + BigInt(to - segment.fileOffset)),
    });
    cursor = Math.max(cursor, to);
  }
  if (cursor < end) fragments.push(unmapped(cursor, end));
  // A section counts only where the range, the section and its segment's
  // file-backed bytes all overlap, so names agree with the fragments.
  const sections = fileBacked.flatMap((segment) =>
    segment.sections
      .filter(
        ({ zerofill, size, offset }) =>
          !zerofill &&
          Math.max(start, offset, segment.fileOffset) <
            Math.min(end, offset + size, segment.fileOffset + segment.fileSize),
      )
      .map(({ name }) => ({ segment: segment.name, section: name })),
  );
  return { status: "mapped", fragments, sections };
};

const unmapped = (from: number, to: number) => ({
  slice_start: from,
  slice_end: to,
  segment: null,
  vm_start: null,
  vm_end: null,
});

/** Decode one segment command, or say why its file mapping is unknown. */
const decodeSegment = ({
  command,
  body,
  index,
}: MachoLoadCommand): SegmentFacts | string => {
  const wide = command === LC_SEGMENT_64;
  const commandSize = wide ? 72 : 56;
  const sectionSize = wide ? 80 : 68;
  if (body.byteLength < commandSize)
    return `load command ${index} is too short for a segment command`;
  const view = viewOf(body);
  const address = (at: number): bigint =>
    wide ? view.getBigUint64(at, true) : BigInt(view.getUint32(at, true));
  const fileOffset = Number(address(wide ? 40 : 32));
  const fileSize = Number(address(wide ? 48 : 36));
  if (!Number.isSafeInteger(fileOffset + fileSize))
    return `load command ${index} segment file range exceeds the safe range`;
  const sectionCount = view.getUint32(wide ? 64 : 48, true);
  if (sectionCount > (body.byteLength - commandSize) / sectionSize)
    return `load command ${index} section records exceed cmdsize`;
  const sections = Array.from({ length: sectionCount }, (_, section) => {
    const at = commandSize + section * sectionSize;
    return {
      name: fixedName(body, at),
      offset: view.getUint32(at + (wide ? 48 : 40), true),
      size: Number(address(at + (wide ? 40 : 36))),
      zerofill: ZEROFILL_SECTION_TYPES.has(
        view.getUint32(at + (wide ? 64 : 56), true) & 0xff,
      ),
    };
  });
  return {
    name: fixedName(body, 8),
    vmAddress: address(24),
    fileOffset,
    fileSize,
    sections,
  };
};

/** A 16-byte NUL-padded loader.h name, decoded byte for byte. */
const fixedName = (body: Uint8Array, at: number): string => {
  const bytes = body.subarray(at, at + 16);
  const end = bytes.indexOf(0);
  // Node's latin1 maps every byte to one code point; WHATWG "latin1" is
  // windows-1252 and would rewrite 0x80-0x9f.
  return Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)).toString(
    "latin1",
  );
};

const hex = (value: bigint): string => `0x${value.toString(16)}`;

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
