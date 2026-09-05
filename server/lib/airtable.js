/**
 * Airtable REST client.
 *
 * Airtable's PATCH /v0/{baseId}/{table} is already a true partial update:
 * fields not named in the payload are left alone. So the integrity work here
 * is limited to never sending a field the user did not map, and batching.
 */
const API_ROOT = 'https://api.airtable.com/v0';
const META_ROOT = 'https://api.airtable.com/v0/meta';
const BATCH_SIZE = 10; // Airtable's hard limit per write request

class AirtableError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'AirtableError';
    this.status = status;
    this.body = body;
  }
}

async function request(token, url, options = {}) {
  if (!token) throw new AirtableError('Airtable token is missing', 401);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
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
      payload?.error?.message || payload?.error?.type || payload?.error || text || 'request failed';
    throw new AirtableError(`Airtable ${response.status}: ${detail}`, response.status, payload);
  }
  return payload;
}

/** Tables + field metadata for a base (needs schema.bases:read on the token). */
export async function listTables(token, baseId) {
  const data = await request(token, `${META_ROOT}/bases/${encodeURIComponent(baseId)}/tables`);
  return (data.tables || []).map((table) => ({
    id: table.id,
    name: table.name,
    primaryFieldId: table.primaryFieldId,
    views: (table.views || []).map((view) => ({ id: view.id, name: view.name })),
    fields: (table.fields || []).map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      readOnly: READ_ONLY_TYPES.has(field.type),
    })),
  }));
}

/** Airtable field types that cannot be written to. */
const READ_ONLY_TYPES = new Set([
  'formula',
  'rollup',
  'count',
  'lookup',
  'multipleLookupValues',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'autoNumber',
  'button',
  'externalSyncSource',
]);

/**
 * Fetch every record in a table/view, following pagination.
 * Falls back to deriving fields from the records when metadata access is not
 * granted on the token.
 */
export async function listRecords(token, { baseId, table, view, fields, maxRecords } = {}) {
  const records = [];
  let offset;

  do {
    const params = new URLSearchParams();
    if (view) params.set('view', view);
    if (offset) params.set('offset', offset);
    params.set('pageSize', '100');
    for (const field of fields || []) params.append('fields[]', field);

    const url = `${API_ROOT}/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}?${params}`;
    const page = await request(token, url);
    records.push(...(page.records || []));
    offset = page.offset;
    if (maxRecords && records.length >= maxRecords) break;
  } while (offset);

  return maxRecords ? records.slice(0, maxRecords) : records;
}

/** Column names inferred from a sample of records (metadata-free fallback). */
export function inferFields(records) {
  const names = new Set();
  for (const record of records) {
    for (const key of Object.keys(record.fields || {})) names.add(key);
  }
  return [...names].map((name) => ({ id: name, name, type: 'unknown', readOnly: false }));
}

/**
 * Partial-update records. `updates` is [{ id, fields }]; only the named
 * fields are touched, everything else in the record is left as-is.
 */
export async function updateRecords(token, { baseId, table, updates, typecast = false }) {
  const results = [];
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const url = `${API_ROOT}/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`;
    const data = await request(token, url, {
      method: 'PATCH', // never PUT: PUT clears fields that are omitted
      body: JSON.stringify({ records: batch, typecast }),
    });
    results.push(...(data.records || []));
  }
  return results;
}

export { AirtableError };
