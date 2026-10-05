import type { ProjectAssetToolsCodec, ProjectAssetToolMethod, ProjectAssetToolsRequests } from "./project-asset-tools-service.js";
export const projectAssetToolsCodec: ProjectAssetToolsCodec;
export function parseProjectAssetToolCommand<M extends ProjectAssetToolMethod>(method:M,input:unknown):ProjectAssetToolsRequests[M];
