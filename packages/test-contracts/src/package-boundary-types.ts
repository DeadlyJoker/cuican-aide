export type Boundary = Readonly<{
  packageName: string;
  allowedBareImports: readonly string[];
  allowedExactBareImports?: readonly string[];
  allowedFileImports?: Readonly<Record<string, readonly string[]>>;
  allowedRuntimeDependencies: readonly string[];
}>;

export type ImportBoundary = Pick<
  Boundary,
  "allowedBareImports" | "allowedExactBareImports" | "allowedFileImports"
>;

export type AppBoundary = Omit<Boundary, "packageName">;
