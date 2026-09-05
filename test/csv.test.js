import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, sniffDelimiter } from '../server/lib/csv.js';

test('parses a plain CSV', () => {
  const { columns, rows } = parseCsv('email,city\na@b.com,Pune\nc@d.com,Mumbai\n');
  assert.deepEqual(columns, ['email', 'city']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { email: 'a@b.com', city: 'Pune' });
});

test('handles quoted fields with commas, quotes and newlines', () => {
  const text = 'name,note\n"Acme, Inc.","He said ""hi""\nsecond line"\n';
  const { rows } = parseCsv(text);
  assert.equal(rows[0].name, 'Acme, Inc.');
  assert.equal(rows[0].note, 'He said "hi"\nsecond line');
});

test('handles CRLF line endings and a BOM', () => {
  const { columns, rows } = parseCsv('﻿a,b\r\n1,2\r\n');
  assert.deepEqual(columns, ['a', 'b']);
  assert.deepEqual(rows[0], { a: '1', b: '2' });
});

test('skips fully blank lines and pads short rows', () => {
  const { rows } = parseCsv('a,b,c\n1,2\n\n4,5,6\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].c, '');
  assert.equal(rows[1].c, '6');
});

test('names unnamed header columns', () => {
  const { columns } = parseCsv('a,,c\n1,2,3\n');
  assert.deepEqual(columns, ['a', 'Column 2', 'c']);
});

test('sniffs the delimiter from the header', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(sniffDelimiter('a,b\n1,2'), ',');
});
