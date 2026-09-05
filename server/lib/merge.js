/**
 * Strict partial-update engine.
 *
 * Everything that decides "what actually gets written" lives here, so the
 * data-integrity rules are enforced in exactly one place:
 *
 *   1. Only explicitly mapped destination fields are ever written.
 *   2. Ownership and audit fields can never be written, even if a mapping
 *      asks for it (hard blocklist, not a UI convention).
 *   3. Unmapped data on the destination record is carried through untouched.
 */

/**
 * Fields that must never be set by a sync, on any Kylas entity. A PUT that
 * omits `ownedBy` is what silently reassigns a record to the API key's user,
 * so these are both un-mappable AND force-carried from the live record.
 */
export const PROTECTED_FIELDS = new Set([
  'id',
  'ownedBy',
  'ownerId',
  'owner',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'createdViaId',
  'createdViaName',
  'createdViaType',
  'updatedViaId',
  'updatedViaName',
  'updatedViaType',
  'recordActions',
  'isNew',
]);

/** Write modes a mapping row can use. */
export const WRITE_MODES = ['replace', 'append', 'fillEmpty'];

export function isProtectedField(name) {
  if (!name) return true;
  const root = String(name).split(/[./]/)[0];
  return PROTECTED_FIELDS.has(root);
}

export function assertMappingIsSafe(mappings) {
  const offenders = (mappings || [])
    .map((m) => m.target)
    .filter((t) => isProtectedField(t));
  if (offenders.length) {
    throw new Error(
      `Refusing to sync: these destination fields are protected and can never be written: ${offenders.join(', ')}`
    );
  }
}

const isBlank = (v) =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/**
 * Combine an existing destination value with an incoming source value
 * according to the mapping's write mode. Returns `{ write, value }` where
 * `write: false` means "leave the destination exactly as it is".
 */
export function resolveValue(existing, incoming, mode = 'replace', options = {}) {
  const { separator = ', ', skipBlankSource = true } = options;

  if (skipBlankSource && isBlank(incoming)) {
    return { write: false, reason: 'source value is empty' };
  }

  if (mode === 'fillEmpty') {
    if (!isBlank(existing)) {
      return { write: false, reason: 'destination already has a value' };
    }
    return { write: true, value: incoming };
  }

  if (mode === 'append') {
    if (isBlank(existing)) return { write: true, value: incoming };

    // Arrays (Airtable multi-select / linked records, Kylas multi-picklist):
    // union, so nothing already selected is dropped.
    if (Array.isArray(existing)) {
      const additions = Array.isArray(incoming) ? incoming : [incoming];
      const seen = new Set(existing.map((v) => JSON.stringify(v)));
      const merged = [...existing];
      for (const add of additions) {
        const key = JSON.stringify(add);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(add);
        }
      }
      if (merged.length === existing.length) {
        return { write: false, reason: 'value already present' };
      }
      return { write: true, value: merged };
    }

    if (typeof existing === 'number' && typeof incoming === 'number') {
      return { write: true, value: existing + incoming };
    }

    const existingText = String(existing);
    const incomingText = String(incoming);
    if (existingText.includes(incomingText)) {
      return { write: false, reason: 'value already present' };
    }
    return { write: true, value: existingText + separator + incomingText };
  }

  // replace
  if (JSON.stringify(existing) === JSON.stringify(incoming)) {
    return { write: false, reason: 'value unchanged' };
  }
  return { write: true, value: incoming };
}

/**
 * Work out the field-level changes for one record without applying them.
 *
 * @param {object} existingRecord live destination record
 * @param {object} sourceRow      source values keyed by source field name
 * @param {Array}  mappings       [{ source, target, mode, custom }]
 * @returns {{changes: object, skipped: Array, customChanges: object}}
 */
export function planChanges(existingRecord, sourceRow, mappings, options = {}) {
  assertMappingIsSafe(mappings);

  const changes = {};
  const customChanges = {};
  const skipped = [];
  const existing = existingRecord || {};
  const existingCustom = existing.customFieldValues || {};

  for (const mapping of mappings) {
    const { source, target, mode = 'replace', custom = false } = mapping;
    const incoming = sourceRow ? sourceRow[source] : undefined;
    const currentValue = custom ? existingCustom[target] : existing[target];

    const outcome = resolveValue(currentValue, incoming, mode, options);
    if (!outcome.write) {
      skipped.push({ target, mode, reason: outcome.reason });
      continue;
    }
    if (custom) customChanges[target] = outcome.value;
    else changes[target] = outcome.value;
  }

  return { changes, customChanges, skipped };
}

/**
 * Build a JSON Patch document (RFC 6902) from a change set. Used for Kylas
 * entities that accept `application/json-patch+json` — the cleanest possible
 * partial update, since untouched fields are never mentioned at all.
 */
export function buildJsonPatch(changes, customChanges = {}) {
  const ops = [];
  for (const [path, value] of Object.entries(changes)) {
    ops.push({ op: 'replace', path: `/${path}`, value });
  }
  for (const [name, value] of Object.entries(customChanges)) {
    ops.push({ op: 'replace', path: `/customFieldValues/${name}`, value });
  }
  return ops;
}

/**
 * Build a full-body payload for endpoints that only accept PUT.
 *
 * A PUT replaces the whole record, so the only safe way to do a partial
 * update is to send the record back exactly as it is with the mapped fields
 * changed. `ownedBy` is re-asserted from the live record explicitly, because
 * dropping it is what causes Kylas to reassign the record.
 */
export function buildMergedPut(existingRecord, changes, customChanges = {}) {
  const existing = existingRecord || {};
  const body = { ...existing, ...changes };

  const existingCustom = existing.customFieldValues || {};
  if (Object.keys(customChanges).length || existing.customFieldValues) {
    body.customFieldValues = { ...existingCustom, ...customChanges };
  }

  // Force-carry ownership straight off the live record. Even if a caller
  // somehow slipped an owner into `changes`, the original wins.
  for (const field of ['ownedBy', 'ownerId', 'createdBy', 'createdAt']) {
    if (existing[field] !== undefined) body[field] = existing[field];
    else delete body[field];
  }

  // Server-managed values: let Kylas recompute them rather than echoing stale
  // ones back. `id` stays in the path, not the body.
  for (const field of ['updatedBy', 'updatedAt', 'recordActions', 'isNew']) {
    delete body[field];
  }

  return body;
}

/** Normalised owner identity for before/after comparison. */
export function ownerOf(record) {
  if (!record) return null;
  if (record.ownedBy && typeof record.ownedBy === 'object') {
    return record.ownedBy.id ?? null;
  }
  if (record.ownedBy !== undefined && record.ownedBy !== null) return record.ownedBy;
  if (record.ownerId !== undefined && record.ownerId !== null) return record.ownerId;
  return null;
}

/** Throws if an update moved the record to a different owner. */
export function assertOwnerUnchanged(before, after, recordId) {
  const from = ownerOf(before);
  const to = ownerOf(after);
  if (from === null || to === null) return;
  if (String(from) !== String(to)) {
    throw new Error(
      `Data integrity violation on record ${recordId}: owner changed from ${from} to ${to}. ` +
        `The update was rejected by the guard — verify this record in Kylas.`
    );
  }
}
