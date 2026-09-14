import type {
  DeliveryAssembleRequest,
  DeliveryCatalog,
  DeliveryInputRecord,
  DeliveryTargetRef,
  DeliveryValidation,
  DeliveryVersionRecord,
  SpreadsheetCellPatch,
  SpreadsheetInspection,
  SpreadsheetPage,
} from "@crewon/domain";

export type SpreadsheetFile = Readonly<{
  inputId: string;
  mediaType: DeliveryInputRecord["mediaType"];
  content: Uint8Array;
}>;
export interface SpreadsheetEnginePort {
  inspect(file: SpreadsheetFile): Promise<SpreadsheetInspection>;
  readPage(
    file: SpreadsheetFile,
    query: { sheet: string; startRow: number; limit: number },
  ): Promise<SpreadsheetPage>;
  assemble(input: {
    template: SpreadsheetFile;
    sources: readonly SpreadsheetFile[];
    request: DeliveryAssembleRequest;
  }): Promise<{
    content: Uint8Array;
    inspection: SpreadsheetInspection;
    validation: DeliveryValidation;
  }>;
  patch(input: {
    file: SpreadsheetFile;
    patches: readonly SpreadsheetCellPatch[];
  }): Promise<{
    content: Uint8Array;
    inspection: SpreadsheetInspection;
    formulaCount: number;
  }>;
}
export type DeliveryScope = Readonly<{
  target: DeliveryTargetRef;
  ownerActorId: string;
}>;
export interface DeliveryStorePort {
  catalog(scope: DeliveryScope): Promise<DeliveryCatalog>;
  getInput(
    scope: DeliveryScope,
    inputId: string,
  ): Promise<{ record: DeliveryInputRecord; content: Uint8Array } | null>;
  getVersion(
    scope: DeliveryScope,
    versionId: string,
  ): Promise<{ record: DeliveryVersionRecord; content: Uint8Array } | null>;
  history(
    scope: DeliveryScope,
    deliveryId: string,
  ): Promise<readonly DeliveryVersionRecord[]>;
  findOperation(
    scope: DeliveryScope,
    key: string,
    fingerprint: string,
  ): Promise<DeliveryInputRecord | DeliveryVersionRecord | null>;
  putInput(input: {
    scope: DeliveryScope;
    record: DeliveryInputRecord;
    content: Uint8Array;
    key: string;
    fingerprint: string;
  }): Promise<DeliveryInputRecord>;
  commitVersion(input: {
    scope: DeliveryScope;
    record: DeliveryVersionRecord;
    content: Uint8Array;
    expected: { versionId: string; contentDigest: string } | null;
    key: string;
    fingerprint: string;
  }): Promise<DeliveryVersionRecord>;
  close(): Promise<void>;
}
