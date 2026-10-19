import { useEffect, useRef } from "react";
import type { ProjectAssetController } from "./ProjectAssetController";
import type { AssetSnapshot } from "./ProjectAssetController.types";

/** A scoped host hint requests a read; it never replaces edits or executes a write. */
export function useProjectAssetInvalidation(
  assets: ProjectAssetController | undefined,
  snapshot: AssetSnapshot | null,
  projectId: string | null,
  revision: number,
) {
  const consumed = useRef({ assets, projectId, revision: 0 });
  if (
    consumed.current.assets !== assets ||
    consumed.current.projectId !== projectId
  )
    consumed.current = { assets, projectId, revision: 0 };
  useEffect(() => {
    if (
      !assets ||
      !snapshot ||
      !projectId ||
      snapshot.projectId !== projectId ||
      revision <= consumed.current.revision ||
      snapshot.dirty ||
      !assets.canRead
    )
      return;
    consumed.current.revision = revision;
    void assets.refresh();
  }, [assets, snapshot, projectId, revision]);
}
