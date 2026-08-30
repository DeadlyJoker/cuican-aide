import { beforeEach, describe, expect, it, vi } from "vitest";

import { prepareComposerAttachments } from "./composerAttachments";

const mocks = vi.hoisted(() => ({
  extractRawText: vi.fn(),
  readWorkbook: vi.fn(),
  sheetToCsv: vi.fn(),
}));

vi.mock("mammoth", () => ({
  extractRawText: mocks.extractRawText,
}));

vi.mock("xlsx", () => ({
  read: mocks.readWorkbook,
  utils: {
    sheet_to_csv: mocks.sheetToCsv,
  },
}));

function binaryFile(name: string): File {
  return {
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    lastModified: 42,
    name,
    size: 8,
    webkitRelativePath: "",
  } as unknown as File;
}

describe("composer attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps Excel parsing available through the deferred xlsx module", async () => {
    const worksheet = { A1: { v: "Name" } };
    mocks.readWorkbook.mockReturnValue({
      SheetNames: ["People"],
      Sheets: { People: worksheet },
    });
    mocks.sheetToCsv.mockReturnValue("Name\nAda");

    await expect(
      prepareComposerAttachments([binaryFile("people.xlsx")]),
    ).resolves.toEqual([
      {
        content: "工作表：People\nName\nAda",
        id: "people.xlsx-42-8",
        name: "people.xlsx",
        relativePath: "people.xlsx",
      },
    ]);
    expect(mocks.readWorkbook).toHaveBeenCalledOnce();
    expect(mocks.sheetToCsv).toHaveBeenCalledWith(worksheet);
  });

  it("keeps DOCX parsing available through the deferred mammoth module", async () => {
    mocks.extractRawText.mockResolvedValue({ value: "Project brief" });

    await expect(
      prepareComposerAttachments([binaryFile("brief.docx")]),
    ).resolves.toEqual([
      {
        content: "Project brief",
        id: "brief.docx-42-8",
        name: "brief.docx",
        relativePath: "brief.docx",
      },
    ]);
    expect(mocks.extractRawText).toHaveBeenCalledOnce();
  });
});
