// What an Excel file (.xlsx) the desktop app edits in place can hold. The writer (workbookXlsx in
// server/export.ts) keeps values, formulas, cell styles, column and row sizes, frozen panes and the filtered
// range; it cannot keep pictures in cells, so a workbook with one is stored in the app's own format instead.
import type { CellData, Workbook } from './types.ts';

/** What the cell holds that an Excel file cannot (named for the user), or null. */
export function xlsxCellProblem(cell: CellData | undefined): string | null {
  return cell?.img ? 'Pictures in cells' : null;
}

/** The first thing in the workbook an Excel file cannot keep, or null when it can be saved as one. */
export function xlsxProblem(wb: Workbook): string | null {
  for (const tab of wb.tabs) {
    for (const key in tab.cells) {
      const problem = xlsxCellProblem(tab.cells[key]);
      if (problem) return problem;
    }
  }
  return null;
}
