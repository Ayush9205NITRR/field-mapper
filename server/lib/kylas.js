/**
 * Kylas CRM client, built around one rule: an update must touch only the
 * mapped fields and must never move a record to a different owner.
 *
 * Kylas exposes two update shapes:
 *   - PATCH with `application/json-patch+json` (leads) — a real partial
 *     update; untouched fields are never mentioned, so ownership is safe by
 *     construction.
 *   - PUT with a full body (contacts, companies, deals) — replaces the whole
 *     record. Sending a partial body here is what wipes unmapped fields and
 *     reassigns the owner to the API key's user. We therefore read the record
 *     first, merge the mapped fields into it, re-assert the original owner,
 *     and verify ownership again after the write.
 */
import {
  planChanges,
  buildJsonPatch,
  buildMergedPut,
  assertOwnerUnchanged,
  ownerOf,
} from './merge.js';

const DEFAULT_BASE_URL = 'https://api.kylas.io/v1';

/** Per-entity API shape. `jsonPatch` marks entities with a true PATCH route. */
export const ENTITIES = {
  lead: { label: 'Leads', path: 'leads', search: 'lead', jsonPatch: true },
  contact: { label: 'Contacts', path: 'contacts', search: 'contact', jsonPatch: false },
  company: { label: 'Companies', path: 'companies', search: 'company', jsonPatch: false },
  deal: { label: 'Deals', path: 'deals', search: 'deal', jsonPatch: false },
};

class KylasError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'KylasError';
    this.status = status;
    this.body = body;
  }
}

export function entityConfig(entity) {
  const config = ENTITIES[entity];
  if (!config) {
    throw new KylasError(
      `Unknown Kylas entity "${entity}". Expected one of: ${Object.keys(ENTITIES).join(', ')}`,
      400
    );
  }
  return config;
}

async function request(ctx, path, options = {}) {
  const { apiKey, baseUrl = DEFAULT_BASE_URL } = ctx;
  if (!apiKey) throw new KylasError('Kylas API key is missing', 401);

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail =
      payload?.message ||
      payload?.error ||
      (Array.isArray(payload?.errors) ? payload.errors.map((e) => e.message || e).join('; ') : null) ||
      text ||
      'request failed';
    throw new KylasError(`Kylas ${response.status}: ${detail}`, response.status, payload);
  }
  return payload;
}

/** Sanity-check credentials and surface who the API key acts as. */
export async function whoami(ctx) {
  const user = await request(ctx, '/users/me');
  return {
    id: user?.id ?? null,
    name: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.name || null,
    email: user?.email ?? null,
    tenantId: user?.tenantId ?? null,
  };
}

/**
 * System + custom fields for an entity, normalised for the mapping UI.
 * Read-only and system-managed fields are marked so they can't be mapped.
 */
export async function listFields(ctx, entity) {
  const config = entityConfig(entity);
  const data = await request(
    ctx,
    `/entities/${config.search}/fields?entityType=${config.search}&custom-only=false&sort=displayName,asc&page=0&size=500`
  );

  const raw = Array.isArray(data) ? data : data?.content || data?.fields || [];
  return raw
    .map((field) => ({
      name: field.name || field.internalName || field.displayName,
      label: field.displayName || field.name,
      type: field.type || 'TEXT_FIELD',
      custom: field.standard === false || field.custom === true,
      required: Boolean(field.required),
      readOnly: Boolean(field.readOnly || field.systemGenerated),
      picklist: field.type === 'PICK_LIST' || field.type === 'MULTI_PICKLIST',
    }))
    .filter((field) => field.name && !field.readOnly)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Fetch one record in full. */
export async function getRecord(ctx, entity, id) {
  const config = entityConfig(entity);
  const data = await request(ctx, `/${config.path}/${encodeURIComponent(id)}`);
  return data?.data ?? data;
}

function searchBody(field, value, extraFields = []) {
  const requested = new Set(['id', 'ownedBy', 'customFieldValues', field, ...extraFields]);
  return {
    fields: [...requested].filter(Boolean),
    jsonRule: {
      condition: 'AND',
      valid: true,
      rules: [
        {
          id: field,
          field,
          type: 'string',
          input: 'text',
          operator: 'equal',
          value,
        },
      ],
    },
  };
}

function freeTextBody(entity, value, extraFields = []) {
  const requested = new Set(['id', 'ownedBy', 'customFieldValues', ...extraFields]);
  return {
    fields: [...requested].filter(Boolean),
    jsonRule: {
      condition: 'AND',
      valid: true,
      rules: [
        {
          id: 'multi_field',
          field: 'multi_field',
          type: 'multi_field',
          input: 'multi_field',
          operator: 'multi_field',
          value,
        },
      ],
    },
  };
}

/** Read a possibly-nested value off a record, e.g. "customFieldValues.code". */
export function readField(record, field, { custom = false } = {}) {
  if (!record) return undefined;
  if (custom) return record.customFieldValues?.[field];
  if (field.includes('.')) {
    return field.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), record);
  }
  const value = record[field];
  // Kylas returns picklists/lookups as { id, name } — compare on the label.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value.name ?? value.value ?? value.id ?? value;
  }
  return value;
}

const sameKey = (a, b) =>
  a !== undefined &&
  a !== null &&
  b !== undefined &&
  b !== null &&
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Find records whose primary key field equals `value`.
 *
 * Tries a field-scoped `equal` rule first and falls back to free-text search;
 * either way every candidate is verified client-side on the exact key value,
 * so a fuzzy backend match can never cause us to write to the wrong record.
 */
export async function findByKey(ctx, entity, { field, value, custom = false, size = 25 }) {
  const config = entityConfig(entity);
  const path = `/search/${config.search}?page=0&size=${size}&sort=updatedAt,desc`;
  const searchField = custom ? 'customFieldValues' : field;

  let candidates = [];
  let strategy = 'field-equal';

  try {
    const data = await request(ctx, path, {
      method: 'POST',
      body: JSON.stringify(searchBody(searchField, value, [field])),
    });
    candidates = data?.content || data?.data?.content || [];
  } catch (error) {
    if (error.status && error.status >= 500) throw error;
    strategy = 'free-text';
    const data = await request(ctx, path, {
      method: 'POST',
      body: JSON.stringify(freeTextBody(entity, value, [field])),
    });
    candidates = data?.content || data?.data?.content || [];
  }

  // If the field-scoped query came back empty it may simply not be a
  // searchable field; retry as free text before declaring "no match".
  if (!candidates.length && strategy === 'field-equal') {
    strategy = 'free-text';
    const data = await request(ctx, path, {
      method: 'POST',
      body: JSON.stringify(freeTextBody(entity, value, [field])),
    });
    candidates = data?.content || data?.data?.content || [];
  }

  const matches = candidates.filter((record) =>
    sameKey(readField(record, field, { custom }), value)
  );

  return { matches, strategy, candidateCount: candidates.length };
}

/**
 * Apply a strictly partial update to one Kylas record.
 *
 * @param {object}  ctx        { apiKey, baseUrl }
 * @param {string}  entity     lead | contact | company | deal
 * @param {string}  id         record id
 * @param {object}  sourceRow  values keyed by source field name
 * @param {Array}   mappings   [{ source, target, mode, custom }]
 * @param {object}  options    { dryRun, existing, separator }
 */
export async function partialUpdate(ctx, entity, id, sourceRow, mappings, options = {}) {
  const config = entityConfig(entity);
  const { dryRun = false, existing: preloaded } = options;

  // Always read the live record first: it is both the merge base for PUT and
  // the reference for the owner check.
  const before = preloaded || (await getRecord(ctx, entity, id));

  const { changes, customChanges, skipped } = planChanges(before, sourceRow, mappings, options);
  const changedFields = [...Object.keys(changes), ...Object.keys(customChanges)];

  const plan = {
    id,
    entity,
    method: config.jsonPatch ? 'PATCH (json-patch)' : 'PUT (read-merge-write)',
    owner: ownerOf(before),
    changes,
    customChanges,
    skipped,
    changedFields,
  };

  if (!changedFields.length) {
    return { ...plan, status: 'unchanged', applied: false };
  }
  if (dryRun) {
    return { ...plan, status: 'planned', applied: false };
  }

  if (config.jsonPatch) {
    const patch = buildJsonPatch(changes, customChanges);
    const after = await request(ctx, `/${config.path}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patch),
    });
    const afterRecord = after?.data ?? after;
    // The PATCH response is not always the full record; re-read to verify.
    const verified =
      ownerOf(afterRecord) !== null ? afterRecord : await getRecord(ctx, entity, id);
    assertOwnerUnchanged(before, verified, id);
    return { ...plan, status: 'updated', applied: true, payload: patch };
  }

  const body = buildMergedPut(before, changes, customChanges);
  const after = await request(ctx, `/${config.path}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  const afterRecord = after?.data ?? after;
  const verified = ownerOf(afterRecord) !== null ? afterRecord : await getRecord(ctx, entity, id);
  assertOwnerUnchanged(before, verified, id);

  return { ...plan, status: 'updated', applied: true, ownerAfter: ownerOf(verified) };
}

export { KylasError, DEFAULT_BASE_URL };
