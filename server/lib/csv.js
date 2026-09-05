/**
 * Small RFC 4180 CSV parser. Handles quoted fields, embedded commas,
 * embedded newlines, escaped quotes and CRLF — enough for real exports
 * without pulling in a dependency.
 */
export function parseCsv(text, { delimiter = ',' } = {}) {
  const input = text.replace(/^﻿/, ''); // strip BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let hadContent = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // Ignore trailing blank line
    if (row.length === 1 && row[0] === '' && !hadContent) {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
    hadContent = false;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      hadContent = true;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      hadContent = true;
    } else if (char === delimiter) {
      endField();
      hadContent = true;
    } else if (char === '\r') {
      if (input[i + 1] === '\n') i++;
      endRow();
    } else if (char === '\n') {
      endRow();
    } else {
      field += char;
      hadContent = true;
    }
  }

  if (field !== '' || row.length || hadContent) endRow();

  if (!rows.length) return { columns: [], rows: [] };

  const columns = rows[0].map((h, index) => {
    const name = h.trim();
    return name || `Column ${index + 1}`;
  });

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    if (values.every((v) => v.trim() === '')) continue;
    const record = {};
    columns.forEach((col, index) => {
      record[col] = values[index] !== undefined ? values[index].trim() : '';
    });
    records.push(record);
  }

  return { columns, rows: records };
}

/** Detect the most likely delimiter from the header line. */
export function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}
