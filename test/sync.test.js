/**
 * End-to-end workflow tests against a stubbed HTTP layer. These assert on the
 * actual request bodies sent to Airtable and Kylas, which is where the
 * data-integrity guarantees either hold or break.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { csvToAirtable, airtableToKylas } from '../server/lib/sync.js';
import { partialUpdate } from '../server/lib/kylas.js';

const realFetch = globalThis.fetch;
let calls = [];

/** Install a fetch stub driven by a url -> handler routing table. */
function stubFetch(routes) {
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method, body, headers: options.headers || {} });

    for (const [pattern, handler] of routes) {
      if (pattern.test(String(url))) {
        const result = await handler({ method, body, url: String(url) });
        return new Response(JSON.stringify(result ?? {}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: `no stub for ${url}` }), { status: 404 });
  };
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (method, pattern) =>
  calls.find((c) => c.method === method && pattern.test(c.url));

/* ------------------------------------------------ Workflow 1: CSV → AT --- */

test('CSV to Airtable patches only mapped fields on matched records', async () => {
  stubFetch([
    [
      /api\.airtable\.com\/v0\/appX\/Contacts\?/,
      () => ({
        records: [
          { id: 'rec1', fields: { Email: 'a@b.com', City: 'Pune', Notes: 'existing' } },
          { id: 'rec2', fields: { Email: 'z@z.com', City: 'Delhi' } },
        ],
      }),
    ],
    [/api\.airtable\.com\/v0\/appX\/Contacts$/, ({ body }) => ({ records: body.records })],
  ]);

  const report = await csvToAirtable({
    token: 'pat_test',
    rows: [
      { Email: 'a@b.com', City: 'Mumbai', Note: 'from csv' },
      { Email: 'missing@x.com', City: 'Nowhere' },
    ],
    sourceKey: 'Email',
    baseId: 'appX',
    table: 'Contacts',
    destinationKey: 'Email',
    mappings: [
      { source: 'City', target: 'City', mode: 'replace' },
      { source: 'Note', target: 'Notes', mode: 'append' },
    ],
    dryRun: false,
  });

  assert.equal(report.summary.updated, 1);
  assert.equal(report.summary.unmatched, 1);

  const write = call('PATCH', /Contacts$/);
  assert.ok(write, 'expected a PATCH write');
  assert.equal(write.body.records.length, 1);
  assert.equal(write.body.records[0].id, 'rec1');
  // Only the two mapped fields, and Notes appended rather than replaced.
  assert.deepEqual(Object.keys(write.body.records[0].fields).sort(), ['City', 'Notes']);
  assert.equal(write.body.records[0].fields.City, 'Mumbai');
  assert.equal(write.body.records[0].fields.Notes, 'existing, from csv');
});

test('a dry run writes nothing', async () => {
  stubFetch([
    [
      /api\.airtable\.com\/v0\/appX\/Contacts\?/,
      () => ({ records: [{ id: 'rec1', fields: { Email: 'a@b.com', City: 'Pune' } }] }),
    ],
  ]);

  const report = await csvToAirtable({
    token: 'pat_test',
    rows: [{ Email: 'a@b.com', City: 'Mumbai' }],
    sourceKey: 'Email',
    baseId: 'appX',
    table: 'Contacts',
    destinationKey: 'Email',
    mappings: [{ source: 'City', target: 'City', mode: 'replace' }],
    dryRun: true,
  });

  assert.equal(report.summary.updated, 1);
  assert.equal(report.results[0].status, 'planned');
  assert.equal(call('PATCH', /./), undefined, 'no write should have been issued');
});

test('duplicate destination keys are reported, not written', async () => {
  stubFetch([
    [
      /api\.airtable\.com\/v0\/appX\/Contacts\?/,
      () => ({
        records: [
          { id: 'rec1', fields: { Email: 'dup@b.com', City: 'Pune' } },
          { id: 'rec2', fields: { Email: 'dup@b.com', City: 'Delhi' } },
        ],
      }),
    ],
  ]);

  const report = await csvToAirtable({
    token: 'pat_test',
    rows: [{ Email: 'dup@b.com', City: 'Mumbai' }],
    sourceKey: 'Email',
    baseId: 'appX',
    table: 'Contacts',
    destinationKey: 'Email',
    mappings: [{ source: 'City', target: 'City', mode: 'replace' }],
    dryRun: false,
  });

  assert.equal(report.summary.ambiguous, 1);
  assert.equal(call('PATCH', /./), undefined);
});

/* --------------------------------------------- Workflow 2: AT → Kylas --- */

const CONTACT = {
  id: 55,
  firstName: 'Ann',
  lastName: 'Lee',
  city: 'Pune',
  designation: 'CTO',
  emails: [{ type: 'OFFICE', value: 'a@b.com', primary: true }],
  ownedBy: { id: 7, name: 'Priya' },
  createdBy: { id: 7, name: 'Priya' },
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-06-01T00:00:00Z',
  customFieldValues: { accountCode: 'A1', region: 'West' },
};

test('full Airtable to Kylas run updates matched records and skips the rest', async () => {
  const writes = [];

  stubFetch([
    [
      /api\.airtable\.com\/v0\/appX\/Contacts\?/,
      () => ({
        records: [
          { id: 'recA', fields: { Email: 'a@b.com', City: 'Mumbai' } },
          { id: 'recB', fields: { Email: 'nobody@x.com', City: 'Nowhere' } },
          { id: 'recC', fields: { City: 'No key here' } },
        ],
      }),
    ],
    [
      /\/search\/contact/,
      ({ body }) => {
        const wanted = body.jsonRule.rules[0].value;
        return wanted === 'a@b.com'
          ? { content: [{ id: 55, emails: 'a@b.com', ownedBy: { id: 7 } }] }
          : { content: [] };
      },
    ],
    [
      /\/contacts\/55$/,
      ({ method, body }) => {
        if (method === 'PUT') {
          writes.push(body);
          return { ...CONTACT, ...body, id: 55 };
        }
        return CONTACT;
      },
    ],
  ]);

  const report = await airtableToKylas({
    token: 'pat_test',
    apiKey: 'key_test',
    baseId: 'appX',
    table: 'Contacts',
    sourceKey: 'Email',
    entity: 'contact',
    destinationKey: 'emails',
    mappings: [{ source: 'City', target: 'city', mode: 'replace' }],
    dryRun: false,
  });

  assert.equal(report.summary.updated, 1);
  assert.equal(report.summary.unmatched, 2, 'no-match and missing-key rows are both skipped');
  assert.equal(writes.length, 1, 'exactly one record written');
  assert.equal(writes[0].city, 'Mumbai');
  assert.deepEqual(writes[0].ownedBy, { id: 7, name: 'Priya' }, 'owner survived the round trip');
  assert.equal(writes[0].designation, 'CTO', 'unmapped field survived');
});

test('partialUpdate on a PUT-only entity sends the whole record with the owner intact', async () => {
  let putBody = null;

  stubFetch([
    [
      /\/contacts\/55$/,
      ({ method, body }) => {
        if (method === 'PUT') {
          putBody = body;
          return { ...CONTACT, ...body, id: 55 };
        }
        return CONTACT;
      },
    ],
  ]);

  const result = await partialUpdate(
    { apiKey: 'key_test' },
    'contact',
    55,
    { City: 'Mumbai', Code: 'B2' },
    [
      { source: 'City', target: 'city', mode: 'replace' },
      { source: 'Code', target: 'accountCode', mode: 'replace', custom: true },
    ]
  );

  assert.equal(result.status, 'updated');
  assert.deepEqual(result.changedFields.sort(), ['accountCode', 'city']);

  // The record was read before it was written.
  assert.ok(call('GET', /\/contacts\/55$/), 'expected a read before the write');

  // The PUT carried the full record, not a partial body.
  assert.equal(putBody.city, 'Mumbai');
  assert.equal(putBody.designation, 'CTO', 'unmapped field must survive');
  assert.equal(putBody.lastName, 'Lee');
  assert.deepEqual(putBody.emails, CONTACT.emails);
  assert.deepEqual(putBody.ownedBy, { id: 7, name: 'Priya' }, 'owner must be re-sent unchanged');
  assert.equal(putBody.customFieldValues.region, 'West', 'unmapped custom field must survive');
  assert.equal(putBody.customFieldValues.accountCode, 'B2');
});

test('a Kylas update that reassigns the owner is surfaced as a failure', async () => {
  stubFetch([
    [
      /\/contacts\/55$/,
      ({ method }) =>
        method === 'PUT'
          ? { ...CONTACT, ownedBy: { id: 99, name: 'API User' } } // server hijacks the owner
          : CONTACT,
    ],
  ]);

  await assert.rejects(
    () =>
      partialUpdate({ apiKey: 'k' }, 'contact', 55, { City: 'Mumbai' }, [
        { source: 'City', target: 'city', mode: 'replace' },
      ]),
    /owner changed from 7 to 99/
  );
});

test('leads use JSON Patch and never mention unmapped fields', async () => {
  let patchBody = null;
  let contentType = null;

  stubFetch([
    [
      /\/leads\/12$/,
      ({ method, body }) => {
        if (method === 'PATCH') {
          patchBody = body;
          return { ...CONTACT, id: 12, city: 'Mumbai' };
        }
        return { ...CONTACT, id: 12 };
      },
    ],
  ]);

  const result = await partialUpdate({ apiKey: 'k' }, 'lead', 12, { City: 'Mumbai' }, [
    { source: 'City', target: 'city', mode: 'replace' },
  ]);

  contentType = calls.find((c) => c.method === 'PATCH').headers['Content-Type'];
  assert.equal(contentType, 'application/json-patch+json');
  assert.deepEqual(patchBody, [{ op: 'replace', path: '/city', value: 'Mumbai' }]);
  assert.equal(result.status, 'updated');
});

test('no mapped value changes means no request is sent', async () => {
  stubFetch([[/\/contacts\/55$/, () => CONTACT]]);

  const result = await partialUpdate({ apiKey: 'k' }, 'contact', 55, { City: 'Pune' }, [
    { source: 'City', target: 'city', mode: 'replace' },
  ]);

  assert.equal(result.status, 'unchanged');
  assert.equal(result.applied, false);
  assert.equal(call('PUT', /./), undefined);
});

test('a mapping onto a protected field is refused before any request', async () => {
  stubFetch([[/\/contacts\/55$/, () => CONTACT]]);

  await assert.rejects(
    () =>
      partialUpdate({ apiKey: 'k' }, 'contact', 55, { Owner: 99 }, [
        { source: 'Owner', target: 'ownedBy', mode: 'replace' },
      ]),
    /protected/i
  );
});
