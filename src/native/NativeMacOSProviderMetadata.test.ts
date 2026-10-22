import { describe, expect, it } from "vitest";

import { nativeMacOSCapabilities } from "./NativeMacOSProviderMetadata.js";

describe("native macOS capability effects", () => {
  it("advertises the temporary snapshot written by inspect_signature", () => {
    const signature = nativeMacOSCapabilities("darwin").find(
      (capability) => capability.operation === "inspect_signature",
    );
    expect(signature?.effects.mayWriteFilesystem).toBe(true);
    expect(signature?.effects.launchesProcess).toBe(true);
  });
});
