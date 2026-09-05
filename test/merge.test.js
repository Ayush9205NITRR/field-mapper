import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveValue,
  planChanges,
  buildJsonPatch,
  buildMergedPut,
  assertMappingIsSafe,
  assertOwnerUnchanged,
  isProtectedField,
  ownerOf,
} from '../server/lib/merge.js';

test('replace only writes when the value actually differs', () => {
  assert.equal(resolveValue('old', 'new', 'replace').write, true);
  assert.equal(resolveValue('same', 'same', 'replace').write, false);
});

test('empty source values never overwrite existing data', () => {
  for (const empty of ['', '   ', null, undefined, []]) {
    assert.equal(resolveValue('keep me', empty, 'replace').write, false);
  }
});

test('append adds to text without erasing what is there', () => {
  const result = resolveValue('Acme', 'Ltd', 'append', { separator: ' ' });
  assert.equal(result.value, 'Acme Ltd');
});

test('append does not duplicate a value already present', () => {
  assert.equal(resolveValue('Acme Ltd', 'Ltd', 'append').write, false);
});

test('append unions array values instead of replacing them', () => {
  const result = resolveValue(['red', 'blue'], ['blue', 'green'], 'append');
  assert.deepEqual(result.value, ['red', 'blue', 'green']);
});

test('append sums numbers', () => {
  assert.equal(resolveValue(10, 5, 'append').value, 15);
});

test('fillEmpty writes to blank fields only', () => {
  assert.equal(resolveValue('', 'value', 'fillEmpty').write, true);
  assert.equal(resolveValue('existing', 'value', 'fillEmpty').write, false);
});

test('planChanges touches only mapped fields', () => {
  const existing = { firstName: 'Ann', lastName: 'Lee', city: 'Pune', ownedBy: { id: 7 } };
  const { changes } = planChanges(existing, { City: 'Mumbai', Note: 'ignored' }, [
    { source: 'City', target: 'city', mode: 'replace' },
  ]);
  assert.deepEqual(changes, { city: 'Mumbai' });
});

test('planChanges routes custom fields into customFieldValues', () => {
  const existing = { customFieldValues: { accountCode: 'A1' } };
  const { customChanges, changes } = planChanges(existing, { Code: 'B2' }, [
    { source: 'Code', target: 'accountCode', mode: 'replace', custom: true },
  ]);
  assert.deepEqual(customChanges, { accountCode: 'B2' });
  assert.deepEqual(changes, {});
});

test('protected fields are rejected at mapping time', () => {
  for (const field of ['ownedBy', 'ownerId', 'createdBy', 'id', 'updatedAt']) {
    assert.throws(
      () => assertMappingIsSafe([{ source: 'x', target: field }]),
      /protected/i,
      `${field} should be rejected`
    );
  }
  assert.equal(isProtectedField('ownedBy/id'), true);
  assert.equal(isProtectedField('city'), false);
});

test('json patch mentions only the changed fields', () => {
  const patch = buildJsonPatch({ city: 'Mumbai' }, { accountCode: 'B2' });
  assert.deepEqual(patch, [
    { op: 'replace', path: '/city', value: 'Mumbai' },
    { op: 'replace', path: '/customFieldValues/accountCode', value: 'B2' },
  ]);
});

test('merged PUT keeps unmapped data and the original owner', () => {
  const existing = {
    id: 42,
    firstName: 'Ann',
    lastName: 'Lee',
    city: 'Pune',
    designation: 'CTO',
    ownedBy: { id: 7, name: 'Priya' },
    createdBy: { id: 7 },
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-06-01T00:00:00Z',
    customFieldValues: { accountCode: 'A1', region: 'West' },
  };

  const body = buildMergedPut(existing, { city: 'Mumbai' }, { accountCode: 'B2' });

  assert.equal(body.city, 'Mumbai');            // mapped field applied
  assert.equal(body.designation, 'CTO');        // unmapped field preserved
  assert.equal(body.lastName, 'Lee');
  assert.deepEqual(body.ownedBy, { id: 7, name: 'Priya' }); // owner preserved
  assert.deepEqual(body.createdBy, { id: 7 });
  assert.equal(body.customFieldValues.region, 'West');      // unmapped custom kept
  assert.equal(body.customFieldValues.accountCode, 'B2');
  assert.equal(body.updatedAt, undefined);      // server-managed, not echoed
  assert.equal(body.updatedBy, undefined);
});

test('merged PUT ignores an owner smuggled into the change set', () => {
  const existing = { city: 'Pune', ownedBy: { id: 7 } };
  const body = buildMergedPut(existing, { city: 'Mumbai', ownedBy: { id: 99 } });
  assert.deepEqual(body.ownedBy, { id: 7 });
});

test('owner guard catches a reassignment', () => {
  assert.doesNotThrow(() => assertOwnerUnchanged({ ownedBy: { id: 7 } }, { ownedBy: { id: 7 } }, 1));
  assert.throws(
    () => assertOwnerUnchanged({ ownedBy: { id: 7 } }, { ownedBy: { id: 99 } }, 1),
    /owner changed from 7 to 99/
  );
});

test('ownerOf reads both object and scalar shapes', () => {
  assert.equal(ownerOf({ ownedBy: { id: 7 } }), 7);
  assert.equal(ownerOf({ ownerId: 9 }), 9);
  assert.equal(ownerOf({}), null);
});
