import type { DesktopNativePluginPackageIdentity } from "@crewon/contracts/plugins";

export type DesktopProjectDocumentTarget = Readonly<{
  threadId: string;
  projectId: string;
  packageIdentity: DesktopNativePluginPackageIdentity;
  documentId: string;
}>;
export type DesktopProjectDocument = Readonly<{
  documentId: string;
  content: string;
  revision: number;
  digest: string;
}>;
export type DesktopProjectDocuments = Readonly<{
  read(
    target: DesktopProjectDocumentTarget,
  ): Promise<DesktopProjectDocument | null>;
  save(
    target: DesktopProjectDocumentTarget & {
      expectedRevision: number;
      content: string;
    },
  ): Promise<DesktopProjectDocument>;
  subscribe(
    target: DesktopProjectDocumentTarget,
    changed: () => void,
  ): Promise<() => void>;
}>;
