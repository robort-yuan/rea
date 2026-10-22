import { describe, expect, it } from "vitest";

import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

// A row owns the signature kind its metadata table authorizes. A blob that
// decodes to the other kind is a malformed blob, not clean decoded coverage:
// the row-authorized kind is reported with parse_status "malformed" and the
// mismatch is surfaced as an `invalid-signature-kind` parse issue (#3877).

describe("managed member signature kind authorization (#3877)", () => {
  it("reports a MethodDef whose signature decodes as a field signature", () => {
    // A field signature blob (0x06 ...) placed in a MethodDef row: the blob
    // decodes as kind "field", but the row authorizes kind "method".
    const bytes = buildManagedPeFixture({
      methodSignature: Buffer.from([0x06, 0x08]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.methods[0]?.signature).toMatchObject({
      kind: "method",
      parse_status: "malformed",
    });
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        {
          code: "invalid-signature-kind",
          scope: "metadata.MethodDef:0x06000001",
          detail: expect.stringContaining(
            "MethodDef signature decoded as a field signature",
          ),
        },
      ],
    });
  });

  it("reports a Field whose signature decodes as a method signature", () => {
    // A method signature blob (0x00 ...) placed in a Field row: the blob
    // decodes as kind "method", but the row authorizes kind "field".
    const bytes = buildManagedPeFixture({
      fieldSignature: Buffer.from([0x00, 0x00, 0x01]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.fields[0]?.signature).toMatchObject({
      kind: "field",
      parse_status: "malformed",
    });
    expect(result.methods[0]?.signature).toMatchObject({
      kind: "method",
      parse_status: "decoded",
    });
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        {
          code: "invalid-signature-kind",
          scope: "metadata.Field:0x04000001",
          detail: expect.stringContaining(
            "Field signature decoded as a method signature",
          ),
        },
      ],
    });
  });

  it("keeps a correct-kind signature decoded with complete coverage", () => {
    const bytes = buildManagedPeFixture();
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.methods[0]?.signature).toMatchObject({
      kind: "method",
      parse_status: "decoded",
    });
    expect(result.fields[0]?.signature).toMatchObject({
      kind: "field",
      parse_status: "decoded",
    });
    expect(result.coverage).toEqual({ state: "complete", issues: [] });
  });
});
