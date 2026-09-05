/**
 * Workflow orchestration.
 *
 * Both workflows follow the same shape:
 *   match on a primary key -> plan only the mapped field changes ->
 *   preview (dry run) or apply -> report per record.
 *
 * Every run can be previewed before anything is written, and a preview and a
 * real run take exactly the same code path, so what you see is what happens.
 */
import * as airtable from './airtable.js';
import * as kylas from './kylas.js';
import { planChanges, assertMappingIsSafe } from './merge.js';

const normaliseKey = (value) =>
  value === null || value === undefined ? '' : String(value).trim().toLowerCase();

/** Index destination rows by primary key, tracking duplicates. */
function indexByKey(rows, keyOf) {
  const index = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    const key = normaliseKey(keyOf(row));
    if (!key) continue;
    if (index.has(key)) duplicates.add(key);
    else index.set(key, row);
  }
  return { index, duplicates };
}

function summarise(results) {
  const summary = { total: results.length, updated: 0, unchanged: 0, unmatched: 0, failed: 0, ambiguous: 0 };
  for (const result of results) {
    if (result.status === 'updated' || result.status === 'planned') summary.updated++;
    else if (result.status === 'unchanged') summary.unchanged++;
    else if (result.status === 'unmatched') summary.unmatched++;
    else if (result.status === 'ambiguous') summary.ambiguous++;
    else summary.failed++;
  }
  return summary;
}

/**
 * Workflow 1 — CSV to Airtable.
 *
 * Airtable's PATCH is already non-destructive, so integrity here comes from
 * only ever putting mapped fields in the payload.
 */
export async function csvToAirtable({
  token,
  rows,
  sourceKey,
  baseId,
  table,
  view,
  destinationKey,
  mappings,
  dryRun = true,
  typecast = false,
  separator = ', ',
}) {
  assertMappingIsSafe(mappings);
  if (!sourceKey) throw new Error('Pick a CSV column to use as the primary key.');
  if (!destinationKey) throw new Error('Pick an Airtable field to match on.');
  if (!mappings?.length) throw new Error('Add at least one field mapping.');

  const targetFields = [...new Set([destinationKey, ...mappings.map((m) => m.target)])];
  const records = await airtable.listRecords(token, { baseId, table, view, fields: targetFields });
  const { index, duplicates } = indexByKey(records, (r) => r.fields?.[destinationKey]);

  const results = [];
  const updates = [];

  for (const row of rows) {
    const keyValue = row[sourceKey];
    const key = normaliseKey(keyValue);
    const base = { key: keyValue, sourceKey, destinationKey };

    if (!key) {
      results.push({ ...base, status: 'unmatched', reason: 'source row has no primary key value' });
      continue;
    }
    if (duplicates.has(key)) {
      results.push({
        ...base,
        status: 'ambiguous',
        reason: `more than one Airtable record has ${destinationKey} = "${keyValue}"`,
      });
      continue;
    }

    const target = index.get(key);
    if (!target) {
      results.push({ ...base, status: 'unmatched', reason: 'no matching Airtable record' });
      continue;
    }

    const { changes, skipped } = planChanges(target.fields || {}, row, mappings, { separator });
    const changedFields = Object.keys(changes);

    if (!changedFields.length) {
      results.push({ ...base, recordId: target.id, status: 'unchanged', skipped, changes: {} });
      continue;
    }

    results.push({
      ...base,
      recordId: target.id,
      status: dryRun ? 'planned' : 'updated',
      changes,
      changedFields,
      skipped,
    });
    updates.push({ id: target.id, fields: changes });
  }

  if (!dryRun && updates.length) {
    try {
      await airtable.updateRecords(token, { baseId, table, updates, typecast });
    } catch (error) {
      // Mark the records we attempted so the report stays honest.
      const attempted = new Set(updates.map((u) => u.id));
      for (const result of results) {
        if (attempted.has(result.recordId)) {
          result.status = 'failed';
          result.error = error.message;
        }
      }
    }
  }

  return {
    workflow: 'csv-to-airtable',
    dryRun,
    destinationRecords: records.length,
    duplicateKeys: [...duplicates],
    summary: summarise(results),
    results,
  };
}

/**
 * Workflow 2 — Airtable to Kylas.
 *
 * Each record is matched, then updated through the strict partial-update path
 * in kylas.js: PATCH where available, otherwise read-merge-write with the
 * original owner re-asserted and verified.
 */
export async function airtableToKylas({
  token,
  apiKey,
  baseUrl,
  baseId,
  table,
  view,
  sourceKey,
  entity,
  destinationKey,
  destinationKeyIsCustom = false,
  mappings,
  dryRun = true,
  separator = ', ',
  limit,
}) {
  assertMappingIsSafe(mappings);
  if (!sourceKey) throw new Error('Pick an Airtable field to use as the primary key.');
  if (!destinationKey) throw new Error('Pick a Kylas field to match on.');
  if (!mappings?.length) throw new Error('Add at least one field mapping.');
  kylas.entityConfig(entity);

  const ctx = { apiKey, baseUrl };
  const records = await airtable.listRecords(token, {
    baseId,
    table,
    view,
    maxRecords: limit || undefined,
  });

  const results = [];

  for (const record of records) {
    const row = record.fields || {};
    const keyValue = row[sourceKey];
    const base = {
      key: keyValue,
      sourceRecordId: record.id,
      sourceKey,
      destinationKey,
    };

    if (normaliseKey(keyValue) === '') {
      results.push({ ...base, status: 'unmatched', reason: 'source record has no primary key value' });
      continue;
    }

    try {
      const { matches, strategy, candidateCount } = await kylas.findByKey(ctx, entity, {
        field: destinationKey,
        value: keyValue,
        custom: destinationKeyIsCustom,
      });

      if (!matches.length) {
        results.push({
          ...base,
          status: 'unmatched',
          reason: `no ${entity} in Kylas with ${destinationKey} = "${keyValue}"`,
          searchStrategy: strategy,
          candidateCount,
        });
        continue;
      }
      if (matches.length > 1) {
        results.push({
          ...base,
          status: 'ambiguous',
          reason: `${matches.length} Kylas ${entity} records share ${destinationKey} = "${keyValue}"`,
          matchedIds: matches.map((m) => m.id),
        });
        continue;
      }

      const outcome = await kylas.partialUpdate(ctx, entity, matches[0].id, row, mappings, {
        dryRun,
        separator,
      });
      results.push({ ...base, ...outcome, searchStrategy: strategy });
    } catch (error) {
      results.push({ ...base, status: 'failed', error: error.message });
    }
  }

  return {
    workflow: 'airtable-to-kylas',
    dryRun,
    entity,
    sourceRecords: records.length,
    summary: summarise(results),
    results,
  };
}
