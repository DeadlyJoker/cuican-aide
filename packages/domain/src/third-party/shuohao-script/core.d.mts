export type ScriptParams = {
  charsPerSecond: number;
  actionSeconds: number;
  tolerance: number;
  maxLineChars: number;
  hookWindow: number;
};
export const DEFAULT_PARAMS: ScriptParams;
export function paramsOf(document: unknown): ScriptParams;
export function lineChars(line: unknown): number;
export function sceneSeconds(
  scene: unknown,
  params?: ScriptParams,
): {
  dialogue: number;
  action: number;
  total: number;
};
export type ScriptStats = {
  params: ScriptParams;
  episodes: {
    ep: number;
    target: number;
    est: number;
    dialogueSeconds: number;
    actionSeconds: number;
    lines: number;
    sceneCount: number;
  }[];
  sceneTable: {
    ep: number;
    index: number;
    sceneId: string;
    lighting: string;
    characters: string[];
    props: string[];
    lineCount: number;
    estSeconds: number;
  }[];
  castLines: {
    id: string;
    count: number;
    chars: number;
    lines: {
      ep: number;
      sceneIndex: number;
      sceneId: string;
      line: string;
      delivery: string;
    }[];
  }[];
  totals: {
    episodes: number;
    scenes: number;
    lines: number;
    estSeconds: number;
    targetSeconds: number;
    dialogueSeconds: number;
  };
};
export function computeStats(document: unknown): ScriptStats;
export function gateReport(
  document: unknown,
  context?: unknown,
): {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}[];
export function validateScript(document: unknown, context?: unknown): string[];
