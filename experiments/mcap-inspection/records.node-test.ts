import assert from "node:assert/strict";
import { test } from "node:test";
import { McapByteReader, Opcode, parseRecord, TempBuffer } from "@mcap/core";
import { validateSummaryRecords } from "./records.ts";
import { inspectSummary } from "./summary.ts";
import { recording } from "./fixtures.ts";

test("each SDK parse is restricted to its declared record boundary", () => {
  const bytes = Buffer.alloc(29);
  bytes[0] = Opcode.CHANNEL;
  bytes.writeBigUInt64LE(4n, 1);
  bytes.writeUInt32LE(4, 13);
  bytes.write("tail", 17);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unbounded = parseRecord(new McapByteReader(view));
  assert.equal(unbounded?.type, "Channel");
  if (unbounded?.type === "Channel") assert.equal(unbounded.topic, "tail");
  assert.throws(() => validateSummaryRecords(bytes), /record boundary/);
});

test("inspection rejects a short summary frame and retains the read evidence", async () => {
  const bytes = await recording();
  const footer = bytes.length - 37;
  const start = Number(bytes.readBigUInt64LE(footer + 9));
  bytes.writeBigUInt64LE(0n, start + 1);
  bytes.writeUInt32LE(0, footer + 25);
  const result = await inspectSummary(new TempBuffer(bytes));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "reader_rejected");
    assert.match(result.error.message, /record boundary/);
    assert.equal(result.error.read_ranges.length, 4);
  }
});
