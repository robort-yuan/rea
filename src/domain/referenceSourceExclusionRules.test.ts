import { describe, expect, it } from "vitest";

import {
  MAX_REFERENCE_SOURCE_EXCLUSION_RULES,
  parseReferenceSourceExclusionRules,
} from "./referenceSourceExclusionRules.js";

describe("reference source exclusion rules", () => {
  it("accepts Git-ignore-style rules", () => {
    const parsed = parseReferenceSourceExclusionRules([
      "vendor",
      "vendor/",
      "*.tmp",
      "/build",
      "docs/generated/**",
    ]);
    expect(parsed).toEqual({
      ok: true,
      rules: ["vendor", "vendor/", "*.tmp", "/build", "docs/generated/**"],
    });
  });

  it("accepts an empty rule list", () => {
    expect(parseReferenceSourceExclusionRules([])).toEqual({
      ok: true,
      rules: [],
    });
  });

  it("rejects a value that is not a rule list", () => {
    const parsed = parseReferenceSourceExclusionRules("vendor");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual([
      { path: [], reason: "invalid_type", expected: "array" },
    ]);
  });

  it("rejects a rule that is not a string", () => {
    const parsed = parseReferenceSourceExclusionRules(["vendor", 7]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual([
      { path: [1], reason: "invalid_type", expected: "string" },
    ]);
  });

  it("rejects blank rules", () => {
    const parsed = parseReferenceSourceExclusionRules(["  "]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({
      path: [0],
      reason: "invalid_value",
      message: "Exclusion rules must not be blank.",
    });
  });

  it("rejects rules that carry control characters", () => {
    for (const rule of [
      "vendor\nother",
      "vendor\rother",
      "vendor\u0000other",
    ]) {
      const parsed = parseReferenceSourceExclusionRules([rule]);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.issues[0]).toMatchObject({
        path: [0],
        reason: "invalid_value",
        message: "Exclusion rules must not contain control characters.",
      });
    }
  });

  it("rejects absolute host paths", () => {
    for (const rule of ["C:\\source", "c:/source", "\\\\host\\share"]) {
      const parsed = parseReferenceSourceExclusionRules([rule]);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.issues[0]).toMatchObject({
        path: [0],
        reason: "invalid_value",
        message:
          "Exclusion rules must be relative to the imported root, not absolute host paths.",
      });
    }
  });

  it("bounds the accepted rule count", () => {
    const parsed = parseReferenceSourceExclusionRules(
      Array.from(
        { length: MAX_REFERENCE_SOURCE_EXCLUSION_RULES + 1 },
        (_, index) => `rule-${String(index)}`,
      ),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]).toMatchObject({
      path: [],
      reason: "out_of_range",
      maximum: MAX_REFERENCE_SOURCE_EXCLUSION_RULES,
    });
  });
});
