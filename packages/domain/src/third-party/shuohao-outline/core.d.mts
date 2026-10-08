export type ShuohaoOutlineGate = Readonly<{
  id: string;
  label: string;
  ok: boolean | string;
  detail: string;
  enKey?: string;
}>;
export function primarySceneCap(episodes: number): number;
export function gateReport(outline: unknown): ShuohaoOutlineGate[];
export function validateOutline(
  outline: unknown,
  stage?: "skeleton" | "beats" | "full",
): string[];
