# Field Mapper

A minimal, UI-driven tool for syncing records between **CSV**, **Airtable** and **Kylas CRM**.

You match records on a primary key, pick exactly which fields to update, preview
every change, then run it. Nothing that you did not map is touched.

```
Workflow 1   CSV        →  Airtable
Workflow 2   Airtable   →  Kylas (Leads, Contacts, Companies, Deals)
```

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

Credentials can be typed into the UI, or set once in `.env` so they never
reach the browser at all:

```bash
cp .env.example .env    # fill in AIRTABLE_TOKEN / KYLAS_API_KEY
```

When a key is present in `.env` the matching input disappears from the UI.

## The data-integrity guarantees

This is the part the tool exists for.

**1. Only mapped fields are ever written.** The change set is built field by
field from your mapping list. A field you did not map is never in the payload.

**2. The record owner is never reassigned.** Kylas exposes a real `PATCH`
route only for leads. Contacts, companies and deals accept `PUT` only, and a
`PUT` replaces the whole record — sending a partial body there is what wipes
unmapped fields and silently reassigns the record to the API key's user. So for
those entities the tool:

- reads the live record first,
- merges only your mapped fields into it,
- re-sends `ownedBy` / `createdBy` / `createdAt` straight off the live record,
- drops server-managed values (`updatedAt`, `updatedBy`, …) so Kylas recomputes them,
- re-reads the owner after the write and **fails loudly** if it changed.

For leads it sends a JSON Patch instead, which mentions only the changed paths.

**3. Ownership and audit fields cannot be mapped at all.** `ownedBy`, `ownerId`,
`createdBy`, `updatedBy`, `id` and friends are on a hard blocklist in
`server/lib/merge.js`. They are filtered out of the UI's target dropdown *and*
rejected server-side, so a hand-crafted API call cannot get around it.

**4. Empty source values never overwrite existing data.** A blank CSV cell or
empty Airtable field is skipped, not written as an empty string.

**5. Nothing is written until you press Run.** Preview and Run take the same
code path; preview simply stops before the request.

## Write modes

Each mapping row picks how the value lands:

| Mode | Behaviour |
| --- | --- |
| **Replace** | Overwrite the destination value (skipped if already identical). |
| **Append** | Add to what is there. Text is concatenated with a separator, arrays and multi-selects are unioned, numbers are summed. Never erases the existing value, and will not duplicate a value already present. |
| **Only if empty** | Write only when the destination field is blank. |

## Primary key matching

A record is updated only when the source key value matches the destination key
value exactly (trimmed, case-insensitive).

- **No match** → reported and skipped. The tool never creates records.
- **More than one match** → reported as ambiguous and skipped, so an update
  can never land on the wrong record.

For Kylas the search runs as a field-scoped `equal` query and falls back to
free-text search, but **every candidate is re-verified client-side on the exact
key value** — a fuzzy backend match can never cause a write to the wrong record.

## Project layout

```
server/
  index.js            Express app, static hosting, .env loader
  routes/api.js       HTTP API used by the UI
  lib/merge.js        ★ the partial-update engine — write modes, owner guard
  lib/kylas.js        Kylas client: fields, key search, strict partial update
  lib/airtable.js     Airtable client: schema, records, batched PATCH
  lib/sync.js         Workflow orchestration + per-record reporting
  lib/csv.js          RFC 4180 CSV parser (no dependency)
public/               Zero-build UI: index.html, app.js, styles.css
test/                 node:test suites
```

The only runtime dependency is Express. The UI has no build step.

## Tests

```bash
npm test
```

30 tests covering the merge engine, the CSV parser, and both workflows
end-to-end against a stubbed HTTP layer. The workflow tests assert on the
actual request bodies sent to Airtable and Kylas, including that a contact
`PUT` carries the original owner and every unmapped field, and that an upstream
owner reassignment is surfaced as a failure.

## Airtable token scopes

- `data.records:read`, `data.records:write` — required.
- `schema.bases:read` — optional. With it you get field types, view names and
  read-only field detection; without it the tool infers columns from a sample
  of records.

## Notes

- Airtable writes are batched 10 records per request (the API limit) and always
  use `PATCH`, never `PUT`.
- Airtable's `typecast` option is off by default (advanced toggle) so values
  that do not fit a field are rejected rather than silently coerced.
- Read-only Airtable fields (formulas, rollups, lookups, created time) are
  excluded from the mapping targets.
