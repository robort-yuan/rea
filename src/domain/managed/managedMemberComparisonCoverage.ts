import type {
  ManagedMemberComparisonResult,
  ManagedMemberComparisonSide,
} from "./managedMemberComparison.js";
import type { ManagedMemberInspection } from "./managedArtifact.js";
import {
  cilOperandsComparable,
  hasSignatureResolution,
} from "./managedMemberSignatureIdentity.js";

interface ComparisonCoverageInput {
  readonly left: ManagedMemberInspection;
  readonly right: ManagedMemberInspection;
}

export const buildComparisonCoverage = ({
  left,
  right,
}: ComparisonCoverageInput): ManagedMemberComparisonResult["coverage"] => {
  const leftStatus = sideCoverageStatus(left);
  const rightStatus = sideCoverageStatus(right);
  const unknownInput =
    left.coverage.state !== "complete" ||
    right.coverage.state !== "complete" ||
    !sameSelection(left, right);
  return {
    status:
      !unknownInput && leftStatus === "complete" && rightStatus === "complete"
        ? "complete-within-inputs"
        : "partial",
    left_status: leftStatus,
    right_status: rightStatus,
  };
};

/** Whether both observations inspected the same declaring types. */
const sameSelection = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
): boolean => {
  if (left.selection === null || right.selection === null)
    return left.selection === right.selection;
  const rightNames = new Set(right.selection.type_names);
  return (
    rightNames.size === new Set(left.selection.type_names).size &&
    left.selection.type_names.every((name) => rightNames.has(name))
  );
};

const sideCoverageStatus = (
  result: ManagedMemberInspection,
): ManagedMemberComparisonResult["coverage"]["left_status"] =>
  result.coverage.state === "unavailable"
    ? "unavailable"
    : result.coverage.state === "complete"
      ? "complete"
      : "partial";

export const sideManifest = (
  side: ManagedMemberComparisonSide,
): ManagedMemberComparisonResult["left"] => ({
  evidence_id: side.evidenceId,
  artifact_sha256: side.result.artifact.sha256,
  mvid: side.result.module?.mvid ?? null,
  module_name: side.result.module?.name ?? null,
  metadata_status: side.result.metadata.status,
  methods_total: side.result.methods.length,
  fields_total: side.result.fields.length,
});

export const buildComparisonSummary = (
  items: readonly (
    | ManagedMemberComparisonResult["methods"][number]
    | ManagedMemberComparisonResult["fields"][number]
  )[],
): ManagedMemberComparisonResult["summary"] => ({
  unchanged: items.filter(({ status }) => status === "unchanged").length,
  changed: items.filter(({ status }) => status === "changed").length,
  added: items.filter(({ status }) => status === "added").length,
  removed: items.filter(({ status }) => status === "removed").length,
  unknown: items.filter(({ status }) => status === "unknown").length,
});

export const buildComparisonMatching = (
  methodItems: readonly ManagedMemberComparisonResult["methods"][number][],
  fieldItems: readonly ManagedMemberComparisonResult["fields"][number][],
): ManagedMemberComparisonResult["matching"] => ({
  exact_il_signature: methodItems.filter(
    ({ match }) => match.basis === "exact-il-signature",
  ).length,
  exact_signature: [...methodItems, ...fieldItems].filter(
    ({ match }) => match.basis === "exact-signature",
  ).length,
  structural_method_shape: methodItems.filter(
    ({ match }) => match.basis === "structural-method-shape",
  ).length,
  field_signature: fieldItems.filter(
    ({ match }) => match.basis === "field-signature",
  ).length,
  ambiguous:
    methodItems.filter(({ match }) => match.status === "ambiguous").length +
    fieldItems.filter(({ match }) => match.status === "ambiguous").length,
  unmatched: [...methodItems, ...fieldItems].filter(
    ({ match }) => match.status === "unmatched",
  ).length,
});

/**
 * A current inspection examines ExportedType rows whenever its metadata is
 * admitted. An unavailable one examined nothing, which its own limitation
 * states with the reason, so only Evidence older than the field predates it.
 */
const predatesExportedTypes = (result: ManagedMemberInspection): boolean =>
  result.exported_types === null && result.coverage.state !== "unavailable";

/**
 * Name a side that contributed no members and why, from its own coverage
 * issues or, when it admitted no metadata at all, its own limitations, so the
 * comparison never reads as an empty difference.
 */
const unavailableLimitation = (
  side: "left" | "right",
  result: ManagedMemberInspection,
): string => {
  const reasons =
    result.coverage.issues.length > 0
      ? result.coverage.issues.map(
          ({ code, scope, detail }) => `${code} at ${scope}: ${detail}`,
        )
      : result.limitations;
  return reasons.length === 0
    ? `The ${side} managed member observation is unavailable; none of its members were compared.`
    : `The ${side} managed member observation is unavailable, so none of its members were compared: ${reasons.join("; ")}`;
};

/** Sides that contributed no members, with their reasons, or only some. */
const availabilityLimitations = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
): string[] => [
  ...(left.coverage.state === "unavailable"
    ? [unavailableLimitation("left", left)]
    : []),
  ...(right.coverage.state === "unavailable"
    ? [unavailableLimitation("right", right)]
    : []),
  ...(left.coverage.state === "partial" || right.coverage.state === "partial"
    ? ["At least one managed member observation is partial."]
    : []),
];

/**
 * How CIL operands compared: the scope of nominal identity when both sides
 * attest it, the token fallback when one predates it, and what either leaves
 * of literal comparison. The nominal scope already bounds literals.
 */
const cilOperandLimitations = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
): {
  readonly scope: string[];
  readonly historical: string[];
  readonly literals: string[];
} => {
  const operandsNamed = cilOperandsComparable(left, right);
  const namesOperands = (result: ManagedMemberInspection) =>
    result.methods.some(({ body }) => body.nominal_il_sha256 !== null);
  const nominal =
    operandsNamed && (namesOperands(left) || namesOperands(right));
  return {
    scope: nominal
      ? [
          "Where CIL bytes differ, token operands compare by nominal identity: types by namespace, name, and enclosing names, members by owner, name, and resolved signature, and ldstr literals by text; defining assemblies and CLR binding are not established by this comparison. Equal CIL bytes compare by build-local tokens, so an unchanged method establishes neither unchanged ldstr literals nor unchanged names of what its tokens reference.",
        ]
      : [],
    historical: operandsNamed
      ? []
      : [
          "At least one managed member observation predates CIL operand resolution, so CIL bodies and exception classes compare only by build-local metadata tokens; a token renumbered between builds reads as a cil or exception-shape change.",
        ],
    literals: nominal
      ? []
      : [
          "ldstr literals are not compared; normalized CIL keeps #US tokens rather than decoded text, so an unchanged method does not establish unchanged string literals.",
        ],
  };
};

export const comparisonLimitations = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
): string[] => {
  const limitations: string[] = [
    "Metadata tokens are build-local coordinates; matched pairs are remaps, not persistent identities.",
    "Methods pair within one declared type and name by exact CIL/signature, then signature, then structural shape; only then may exact CIL/signature or structural shape alone remap across declared types or names, never taking a member whose own declared type and name remain unpaired on the other side or whose declaring type is unresolved. Names alone are never a matching basis.",
    "Fields pair by declared type, name, and signature, then remap by exact decoded signature alone under the same rule; an undecoded signature is compared only for an exact signature match, and an unmatched member with one stays unknown.",
  ];
  const namesTypes = (result: ManagedMemberInspection) =>
    result.methods.some(
      ({ signature }) =>
        signature.resolved_sha256 !== null &&
        signature.resolved_sha256 !== signature.raw_sha256,
    ) ||
    result.fields.some(
      ({ signature }) =>
        signature.resolved_sha256 !== null &&
        signature.resolved_sha256 !== signature.raw_sha256,
    );
  if (
    hasSignatureResolution(left) &&
    hasSignatureResolution(right) &&
    (namesTypes(left) || namesTypes(right))
  )
    limitations.push(
      "Signature type operands compare by namespace, name, and enclosing names only; defining assemblies and CLR type identity are not established by this comparison.",
    );
  const operands = cilOperandLimitations(left, right);
  limitations.push(...operands.scope, ...availabilityLimitations(left, right));
  if (!sameSelection(left, right))
    limitations.push(
      "The observations select different declaring types; a member outside the other side's selection is unknown, not added or removed.",
    );
  else if (left.selection !== null)
    limitations.push(
      `Both observations cover only the selected declaring types (${left.selection.type_names.join(", ")}); member totals and statuses describe those types, not the whole assembly.`,
    );
  if (!hasSignatureResolution(left) || !hasSignatureResolution(right))
    limitations.push(
      "At least one managed member observation does not attest signature type-name resolution, so signatures compare by raw bytes, which name types by build-local metadata row.",
    );
  limitations.push(...operands.historical);
  if (left.nesting_read === null || right.nesting_read === null)
    limitations.push(
      "At least one managed member observation predates enclosing-name identity. The legacy bare-name comparison does not establish the enclosing owner of a nested type.",
    );
  if ([left, right].some(predatesExportedTypes))
    limitations.push(
      "At least one managed member observation predates ExportedType inspection; its exported and forwarded types are unknown.",
    );
  if (
    (left.exported_types?.length ?? 0) > 0 ||
    (right.exported_types?.length ?? 0) > 0
  )
    limitations.push(
      "ExportedType rows, including type forwarders, are observed but not compared; an unchanged comparison does not establish an unchanged exported or forwarded type set.",
    );
  limitations.push(...operands.literals);
  return limitations;
};
