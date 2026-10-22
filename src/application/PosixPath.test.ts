import { describe, expect, it } from "vitest";

import { joinPosixPath } from "./PosixPath.js";

describe("POSIX path composition", () => {
  it("preserves literal backslashes in path components", () => {
    expect(joinPosixPath("/Applications", "Hopper\\Preview.app")).toBe(
      "/Applications/Hopper\\Preview.app",
    );
  });
});
