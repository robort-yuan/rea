import canonicalize from "canonicalize";

import type { ManagedMemberInspection } from "./managedArtifact.js";
import type { ManagedMemberComparisonResult } from "./managedMemberComparison.js";
import { signatureIdentity } from "./managedMemberSignatureIdentity.js";

type Method = ManagedMemberInspection["methods"][number];
type MethodItem = ManagedMemberComparisonResult["methods"][number];

/** The token-bearing body facets of a matched method pair. */
interface OperandFacets {
  readonly cil: boolean;
  readonly exceptionShape: boolean;
  /** A facet REA could not decide because an operand has no identity. */
  readonly unknown: boolean;
}

/** Exception clauses with each class as its build-local token or only marked typed. */
const exceptionShape = (
  method: Method,
  classes: "token" | "typed",
): string | undefined =>
  canonicalize(
    method.body.exception_regions.map((region) => [
      region.flags,
      region.try_offset,
      region.try_length,
      region.handler_offset,
      region.handler_length,
      region.class_token === null
        ? null
        : classes === "token"
          ? region.class_token
          : "typed",
      region.filter_offset,
    ]),
  );

/**
 * Compare build-local bytes as the exact-CIL match does, so equal bytes
 * report no change even for members renamed in place. The decoded
 * fingerprint omits switch targets and is not exact CIL identity, so the raw
 * digest is compared too.
 */
const tokenFacets = (left: Method, right: Method): OperandFacets => ({
  cil:
    left.body.il_sha256 !== right.body.il_sha256 ||
    left.body.normalized_il_sha256 !== right.body.normalized_il_sha256,
  exceptionShape:
    exceptionShape(left, "token") !== exceptionShape(right, "token"),
  unknown: false,
});

/**
 * Compare the catch classes of otherwise equal clauses one by one by nominal
 * identity, so a known difference in one clause stays known beside a class
 * REA could not name in another. Only without a known difference does an
 * unnamed class leave the facet unknown.
 */
const catchClassFacets = (
  left: Method,
  right: Method,
): { readonly changed: boolean; readonly unknown: boolean } => {
  const classes = left.body.exception_regions.flatMap((region, index) => {
    const other = right.body.exception_regions[index];
    return region.class_token === null || other === undefined
      ? []
      : [[region.class_identity_sha256, other.class_identity_sha256] as const];
  });
  const changed = classes.some(
    ([named, other]) => named !== null && other !== null && named !== other,
  );
  return {
    changed,
    unknown:
      !changed &&
      classes.some(([named, other]) => named === null || other === null),
  };
};

/**
 * Bytes that differ only in renumbered tokens are not a change: where the
 * build-local bytes differ, nominal operand identity decides. A body REA
 * could not name, or a catch class without a known difference beside it,
 * leaves that facet unknown, since its tokens neither establish nor rule out
 * a change.
 */
const nominalFacets = (left: Method, right: Method): OperandFacets => {
  const tokens = tokenFacets(left, right);
  const cilUnknown =
    tokens.cil &&
    (left.body.nominal_il_sha256 === null ||
      right.body.nominal_il_sha256 === null);
  const clauseChange =
    exceptionShape(left, "typed") !== exceptionShape(right, "typed");
  const classes =
    tokens.exceptionShape && !clauseChange
      ? catchClassFacets(left, right)
      : { changed: false, unknown: false };
  return {
    cil:
      tokens.cil &&
      !cilUnknown &&
      left.body.nominal_il_sha256 !== right.body.nominal_il_sha256,
    exceptionShape: tokens.exceptionShape && (clauseChange || classes.changed),
    unknown: cilUnknown || classes.unknown,
  };
};

export const methodDimensions = (
  left: Method,
  right: Method,
  cilOperandsNamed: boolean,
): {
  readonly dimensions: MethodItem["dimensions"];
  readonly bodyUnknown: boolean;
  readonly operandsUnknown: boolean;
} => {
  const dimensions: MethodItem["dimensions"] = [];
  const headerFields = ["max_stack", "init_locals"] as const;
  const headerChanged = headerFields.some(
    (field) =>
      left.body[field] !== null &&
      right.body[field] !== null &&
      left.body[field] !== right.body[field],
  );
  if (
    left.flags !== right.flags ||
    left.impl_flags !== right.impl_flags ||
    headerChanged
  )
    dimensions.push("metadata");
  if (signatureIdentity(left.signature) !== signatureIdentity(right.signature))
    dimensions.push("signature");
  const leftBodyComplete =
    left.body.status === "present" && left.body.truncated_instructions === 0;
  const rightBodyComplete =
    right.body.status === "present" && right.body.truncated_instructions === 0;
  const bothAbsent =
    left.body.status === "absent" && right.body.status === "absent";
  if (
    (left.body.status === "absent" && rightBodyComplete) ||
    (right.body.status === "absent" && leftBodyComplete)
  )
    dimensions.push("availability");
  if (bothAbsent)
    return { dimensions, bodyUnknown: false, operandsUnknown: false };
  if (!leftBodyComplete || !rightBodyComplete)
    return { dimensions, bodyUnknown: true, operandsUnknown: false };
  const operands = cilOperandsNamed
    ? nominalFacets(left, right)
    : tokenFacets(left, right);
  if (operands.cil) dimensions.push("cil");
  if (
    canonicalize(left.body.opcode_counts) !==
    canonicalize(right.body.opcode_counts)
  )
    dimensions.push("opcode-shape");
  if (callShape(left.body.anchors) !== callShape(right.body.anchors))
    dimensions.push("call-shape");
  if (fieldShape(left.body.anchors) !== fieldShape(right.body.anchors))
    dimensions.push("field-shape");
  if (operands.exceptionShape) dimensions.push("exception-shape");
  return {
    dimensions,
    // An unavailable header value establishes neither equality nor a change.
    bodyUnknown: headerFields.some(
      (field) => left.body[field] === null || right.body[field] === null,
    ),
    operandsUnknown: operands.unknown,
  };
};

const callShape = (anchors: Method["body"]["anchors"]): string =>
  JSON.stringify(
    anchors
      .filter(({ operand_kind }) => operand_kind === "method")
      .map(({ opcode, operand_kind }) => [opcode, operand_kind]),
  );

const fieldShape = (anchors: Method["body"]["anchors"]): string =>
  JSON.stringify(
    anchors
      .filter(({ operand_kind }) => operand_kind === "field")
      .map(({ opcode, operand_kind }) => [opcode, operand_kind]),
  );
