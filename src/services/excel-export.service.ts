import ExcelJS from 'exceljs';

export type ExcelColumn = { header: string; key: string; width?: number };

const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '111827' } } as const;
const headerFont = { color: { argb: 'FFFFFF' }, bold: true, size: 11 } as const;
const titleFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F172A' } } as const;
const titleFont = { color: { argb: 'FFFFFF' }, bold: true, size: 16 } as const;
const metaFont = { color: { argb: '64748B' }, size: 10 } as const;
const border = {
  top: { style: 'thin', color: { argb: 'E2E8F0' } },
  left: { style: 'thin', color: { argb: 'E2E8F0' } },
  bottom: { style: 'thin', color: { argb: 'E2E8F0' } },
  right: { style: 'thin', color: { argb: 'E2E8F0' } }
} as const;

const columnLetter = (index: number) => {
  let result = '';
  let n = index;
  while (n > 0) {
    const mod = (n - 1) % 26;
    result = String.fromCharCode(65 + mod) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
};

export const createWorkbook = (title: string) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LLM Arena';
  workbook.created = new Date();
  workbook.modified = new Date();
  return workbook;
};

export const createStyledSheet = (
  workbook: ExcelJS.Workbook,
  name: string,
  title: string,
  columns: ExcelColumn[]
) => {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns;

  const lastCol = columnLetter(columns.length);
  sheet.mergeCells(`A1:${lastCol}1`);
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = titleFont;
  sheet.getCell('A1').fill = titleFill;
  sheet.getCell('A1').alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 26;

  sheet.mergeCells(`A2:${lastCol}2`);
  sheet.getCell('A2').value = `Generated ${new Date().toLocaleString()}`;
  sheet.getCell('A2').font = metaFont;
  sheet.getCell('A2').alignment = { vertical: 'middle', horizontal: 'left' };

  sheet.addRow([]);
  const headerRow = sheet.addRow(columns.map(col => col.header));
  headerRow.eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = border;
  });

  sheet.views = [{ state: 'frozen', ySplit: 4 }];
  sheet.autoFilter = {
    from: 'A4',
    to: `${lastCol}4`
  };

  return sheet;
};

export const addDataRows = (sheet: ExcelJS.Worksheet, rows: Record<string, any>[], startRow = 5) => {
  rows.forEach((row, index) => {
    const rowRef = sheet.addRow(row);
    rowRef.eachCell(cell => {
      cell.border = border;
    });
    if (index % 2 === 1) {
      rowRef.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8FAFC' } };
      });
    }
  });

  const lastRow = sheet.lastRow ? sheet.lastRow.number : startRow;
  sheet.getRows(startRow, lastRow - startRow + 1)?.forEach(row => {
    row.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
  });
};

export const applyColumnSizing = (sheet: ExcelJS.Worksheet, columns: ExcelColumn[]) => {
  columns.forEach((col, idx) => {
    const column = sheet.getColumn(idx + 1);
    if (col.width) {
      column.width = col.width;
      return;
    }
    let maxLength = col.header.length;
    column.eachCell({ includeEmpty: true }, cell => {
      const value = cell.value ? String(cell.value) : '';
      maxLength = Math.max(maxLength, value.length);
    });
    column.width = Math.min(Math.max(12, maxLength + 2), 60);
  });
};
