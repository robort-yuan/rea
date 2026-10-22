import { describe, expect, it } from "vitest";

import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../../contracts/managed/managedWorkflowExamples.js";
import { createEvidence } from "../evidence.js";
import { jsonValueSchema } from "../jsonValue.js";
import { inspectMachoSchema } from "../native/nativeInspection.js";
import { collectNativeSymbols } from "./managedNativeVerificationMatch.js";

describe("managed/native verification symbol collection", () => {
  it("accepts inspect_macho Evidence retained before encryption reporting", () => {
    const original = MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations[0];
    if (original === undefined)
      throw new Error(
        "Managed verification example is missing native Evidence",
      );
    const { encryption: _omitted, ...legacy } = inspectMachoSchema.parse(
      original.normalized_result,
    );
    const evidence = createEvidence(undefined, original.provider, {
      operation: "inspect_macho",
      parameters: original.parameters,
      result: jsonValueSchema.parse(legacy),
      rawResult: null,
      limitations: [],
    });
    const collected = collectNativeSymbols([evidence]);
    expect(collected.accepted).toBe(1);
    expect(collected.symbols.map(({ name }) => name)).toEqual(
      legacy.exports.items.map(({ name }) => name),
    );
  });
});
