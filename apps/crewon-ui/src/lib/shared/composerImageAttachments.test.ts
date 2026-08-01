import { describe, expect, it } from "vitest";

import { pastedImageFiles } from "./composerImageAttachments";

describe("composer image attachments", () => {
  it("accepts pasted images without adding an image entry to the add palette", () => {
    const image = { name: "screenshot.png" } as File;
    const textFile = { name: "notes.txt" } as File;

    expect(
      pastedImageFiles([
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "text/plain", getAsFile: () => textFile },
        { kind: "file", type: "image/png", getAsFile: () => image },
      ]),
    ).toEqual([image]);
  });
});
