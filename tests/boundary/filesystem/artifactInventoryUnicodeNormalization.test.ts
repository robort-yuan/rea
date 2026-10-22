import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { artifactOccurrenceAt } from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// "cafe" + combining acute U+0301 (NFD) versus precomposed U+00E9 (NFC).
const NFD_NAME = "caf\u0065\u0301.txt";
const NFC_NAME = "caf\u00e9.txt";

const writeZipWithMember = async (
  path: string,
  name: string,
): Promise<void> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(name, new TextReader("evidence\n"));
  await writeFile(path, await writer.close());
};

describe("artifact inventory Unicode normalization", () => {
  it("keeps the NFC logical path and preserves the original NFD spelling", async () => {
    expect(NFD_NAME).not.toBe(NFC_NAME);
    expect(NFD_NAME.normalize("NFC")).toBe(NFC_NAME);
    const root = await createTestTempDirectory("rea-unicode-normalization-");
    const archive = join(root, "nfd.zip");
    await writeZipWithMember(archive, NFD_NAME);

    const inventory = await inventoryArtifact(archive);
    const occurrence = artifactOccurrenceAt(inventory, NFC_NAME);
    // Identity stays on the shared NFC spelling.
    expect(occurrence.logical_path).toBe(NFC_NAME);
    // The archive's decoded spelling is preserved, not silently replaced.
    const limitation = occurrence.limitations.find((item) =>
      item.includes("Unicode-normalized to NFC"),
    );
    expect(limitation).toBeDefined();
    expect(limitation).toContain(JSON.stringify(NFD_NAME));
    expect(limitation?.includes(NFD_NAME)).toBe(true);
  });

  it("records no limitation when the member name is already NFC", async () => {
    const root = await createTestTempDirectory("rea-unicode-normalization-");
    const archive = join(root, "nfc.zip");
    await writeZipWithMember(archive, NFC_NAME);

    const inventory = await inventoryArtifact(archive);
    const occurrence = artifactOccurrenceAt(inventory, NFC_NAME);
    expect(occurrence.logical_path).toBe(NFC_NAME);
    expect(
      occurrence.limitations.some((item) =>
        item.includes("Unicode-normalized to NFC"),
      ),
    ).toBe(false);
  });
});
