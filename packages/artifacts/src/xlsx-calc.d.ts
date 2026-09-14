/** The upstream 0.9.2 package has no declarations; this is its narrow public workbook API. */
declare module "xlsx-calc" {
  export type CalcCell = { v?: unknown; f?: string; t?: string; w?: string };
  export type CalcWorkbook = {
    Sheets: Record<string, Record<string, CalcCell>>;
  };
  export default function calculate(
    workbook: CalcWorkbook,
    options?: { continue_after_error?: boolean; log_error?: boolean },
  ): void;
}
