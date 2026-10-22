import { addressedValueSchema } from "../domain/native/nativeInventory.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisOperationPort } from "./AnalysisProvider.js";
import { resolveProcedureAddress } from "./ProcedureAddressResolution.js";

/** The outcome of selecting one exact name from a parsed symbol inventory. */
export type ExactNameMatch =
  | { readonly status: "missing" }
  | { readonly status: "unique"; readonly address: string }
  | { readonly status: "ambiguous"; readonly message: string };

/**
 * Select the distinct addresses carrying one exact inventory name.
 * Duplicate rows at one address stay unique; more than one distinct
 * address is ambiguous and never silently picks the first.
 */
export const matchExactName = (
  entries: Iterable<{ readonly name: string; readonly address: string }>,
  name: string,
): ExactNameMatch => {
  const addresses = new Set<string>();
  for (const entry of entries)
    if (entry.name === name) addresses.add(entry.address);
  const [address] = addresses;
  if (addresses.size === 0) return { status: "missing" };
  if (addresses.size === 1 && address !== undefined)
    return { status: "unique", address };
  return {
    status: "ambiguous",
    message: `Analyzed symbol name ${JSON.stringify(name)} is ambiguous at ${[...addresses].join(", ")}. Select an exact address.`,
  };
};

/** Resolve a CLI symbol selector without changing existing address spellings. */
export const resolveXrefsAddress = async (
  analysis: AnalysisOperationPort,
  selector: string,
  signal: AbortSignal,
): Promise<Result<string, AnalysisError>> => {
  if (
    selector.length === 0 ||
    /^[0-9a-f]+$/iu.test(selector) ||
    /^0x/iu.test(selector) ||
    /:0x/iu.test(selector)
  )
    return ok(selector);

  const inventory = await analysis.execute("list_names", {}, { signal });
  if (!inventory.ok) {
    if (
      inventory.error instanceof AnalysisCapabilityUnavailableError &&
      inventory.error.operation === "list_names" &&
      !inventory.error.cleanupIncomplete
    )
      return resolveProcedureAddress(
        async (operation, parameters, signal) => {
          const result = await analysis.execute(
            operation,
            parameters,
            signal === undefined ? {} : { signal },
          );
          return result.ok ? ok(result.value.result) : result;
        },
        selector,
        signal,
      );
    return inventory;
  }
  if (!Array.isArray(inventory.value.result))
    return err(
      new AnalysisOutputError(
        "list_names",
        "Expected a symbol inventory array",
      ),
    );

  const entries: { name: string; address: string }[] = [];
  for (const [index, item] of inventory.value.result.entries()) {
    const parsed = addressedValueSchema.safeParse(item);
    if (!parsed.success || parsed.data.address.length === 0)
      return err(
        new AnalysisOutputError(
          "list_names",
          `Invalid symbol inventory entry at index ${index}`,
        ),
      );
    entries.push({ name: parsed.data.value, address: parsed.data.address });
  }
  const match = matchExactName(entries, selector);
  if (match.status === "unique") return ok(match.address);
  return err(
    new AnalysisInputError("xrefs", undefined, [
      {
        path: ["address"],
        reason: "invalid_value",
        message:
          match.status === "missing"
            ? `Unknown analyzed symbol name ${JSON.stringify(selector)}. Use an exact analyzed name or a hexadecimal address.`
            : match.message,
      },
    ]),
  );
};
