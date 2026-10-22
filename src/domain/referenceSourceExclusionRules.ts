import { z } from "zod";

import type { AnalysisInputIssue } from "./analysisErrorCore.js";
import { projectInputIssues } from "./inputIssueProjection.js";

/**
 * Maximum number of caller-selected exclusion rules accepted for one import.
 *
 * Every rule adds a bounded number of patterns to the importer's matcher, so
 * the accepted count is capped to keep one import's preparation work bounded.
 */
export const MAX_REFERENCE_SOURCE_EXCLUSION_RULES = 1_000;

/**
 * One caller-selected exclusion rule in the importer's Git-ignore-style grammar.
 *
 * Rules match paths relative to the imported root. A leading `/` anchors the
 * rule to that root and a trailing `/` limits the rule to directories, so an
 * absolute host path never names an importable path and is rejected.
 */
export const referenceSourceExclusionRuleSchema = z
  .string()
  .refine((rule) => rule.trim().length > 0, {
    message: "Exclusion rules must not be blank.",
  })
  .refine((rule) => !hasControlCharacter(rule), {
    message: "Exclusion rules must not contain control characters.",
  })
  .refine((rule) => !isAbsoluteExclusionRule(rule), {
    message:
      "Exclusion rules must be relative to the imported root, not absolute host paths.",
  });

/** Accepted caller-selected exclusion rules for one import. */
export const referenceSourceExclusionRulesSchema = z
  .array(referenceSourceExclusionRuleSchema)
  .max(MAX_REFERENCE_SOURCE_EXCLUSION_RULES, {
    message: `At most ${String(MAX_REFERENCE_SOURCE_EXCLUSION_RULES)} exclusion rules are accepted.`,
  });

/** Accepted rules, or the caller correction required to accept them. */
export type ReferenceSourceExclusionRulesResult =
  | { readonly ok: true; readonly rules: readonly string[] }
  | { readonly ok: false; readonly issues: readonly AnalysisInputIssue[] };

/**
 * Validate decoded caller-selected exclusion rules.
 *
 * The result carries only the rules and secret-safe correction metadata, so a
 * caller sees which rule was rejected without the importer touching the
 * filesystem.
 */
export const parseReferenceSourceExclusionRules = (
  value: unknown,
): ReferenceSourceExclusionRulesResult => {
  const parsed = referenceSourceExclusionRulesSchema.safeParse(value);
  if (parsed.success) return { ok: true, rules: parsed.data };
  return {
    ok: false,
    issues: projectInputIssues(parsed.error.issues, value),
  };
};

const isAbsoluteExclusionRule = (rule: string): boolean =>
  /^[A-Za-z]:[\\/]/u.test(rule) || rule.startsWith("\\\\");

/** Git-ignore rules are single lines without control characters. */
const hasControlCharacter = (rule: string): boolean =>
  [...rule].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
