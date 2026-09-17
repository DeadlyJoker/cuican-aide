export type OfficeThreadLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  officeId: string;
}>;

/** Stable across Office revisions and Thread renames; never inferred from a title. */
export type OfficeThreadBinding = OfficeThreadLocator &
  Readonly<{
    officeVersionId: string;
    threadId: string;
    boundByActorId: string;
    boundAt: string;
  }>;

export type BindOfficeThreadInput = Readonly<{
  binding: OfficeThreadBinding;
  expectedThreadRevision: number;
}>;

export type BindOfficeThreadResult = Readonly<{
  disposition: "bound" | "existing";
  binding: OfficeThreadBinding;
}>;

export interface OfficeThreadStore {
  loadOfficeThreadBinding(
    locator: OfficeThreadLocator,
  ): Promise<OfficeThreadBinding | null>;
  /** First adoption uses revision CAS; an existing association is immutable and replayable. */
  bindOfficeThread(
    input: BindOfficeThreadInput,
  ): Promise<BindOfficeThreadResult>;
}
