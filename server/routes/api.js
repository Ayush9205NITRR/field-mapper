/**
 * HTTP API consumed by the browser UI.
 *
 * Credentials: every request may carry `airtableToken` / `kylasApiKey` in the
 * body, but if the server has them in .env those win, so a deployment can
 * keep keys entirely server-side and the UI never shows a key field.
 */
import express from 'express';
import * as airtable from '../lib/airtable.js';
import * as kylas from '../lib/kylas.js';
import { csvToAirtable, airtableToKylas } from '../lib/sync.js';
import { parseCsv, sniffDelimiter } from '../lib/csv.js';
import { WRITE_MODES, PROTECTED_FIELDS } from '../lib/merge.js';

const router = express.Router();

const airtableToken = (body = {}) => process.env.AIRTABLE_TOKEN || body.airtableToken || '';
const kylasKey = (body = {}) => process.env.KYLAS_API_KEY || body.kylasApiKey || '';
const kylasUrl = (body = {}) =>
  process.env.KYLAS_BASE_URL || body.kylasBaseUrl || kylas.DEFAULT_BASE_URL;

/** Wrap an async handler so rejections reach the error middleware. */
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** What the UI needs to render itself, including which keys are preconfigured. */
router.get(
  '/config',
  handle(async (_req, res) => {
    res.json({
      writeModes: WRITE_MODES,
      protectedFields: [...PROTECTED_FIELDS],
      entities: Object.entries(kylas.ENTITIES).map(([value, config]) => ({
        value,
        label: config.label,
        partialUpdate: config.jsonPatch ? 'json-patch' : 'read-merge-write',
      })),
      hasAirtableToken: Boolean(process.env.AIRTABLE_TOKEN),
      hasKylasKey: Boolean(process.env.KYLAS_API_KEY),
    });
  })
);

/* ---------------------------------------------------------------- CSV --- */

router.post(
  '/csv/parse',
  handle(async (req, res) => {
    const { text, delimiter } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'No CSV content received.' });
    }
    const useDelimiter = delimiter || sniffDelimiter(text);
    const { columns, rows } = parseCsv(text, { delimiter: useDelimiter });
    if (!columns.length) return res.status(400).json({ error: 'Could not read a header row.' });

    res.json({
      delimiter: useDelimiter,
      columns,
      rowCount: rows.length,
      sample: rows.slice(0, 5),
      rows,
    });
  })
);

/* ----------------------------------------------------------- Airtable --- */

router.post(
  '/airtable/tables',
  handle(async (req, res) => {
    const { baseId } = req.body || {};
    if (!baseId) return res.status(400).json({ error: 'Base ID is required.' });
    const tables = await airtable.listTables(airtableToken(req.body), baseId);
    res.json({ tables });
  })
);

/**
 * Fields for one table. Uses schema metadata when the token allows it and
 * otherwise infers columns from a sample of records, so a data-only token
 * still works.
 */
router.post(
  '/airtable/fields',
  handle(async (req, res) => {
    const { baseId, table, view } = req.body || {};
    if (!baseId || !table) return res.status(400).json({ error: 'Base ID and table are required.' });
    const token = airtableToken(req.body);

    try {
      const tables = await airtable.listTables(token, baseId);
      const match = tables.find((t) => t.name === table || t.id === table);
      if (match) {
        return res.json({ source: 'schema', views: match.views, fields: match.fields });
      }
    } catch {
      // Token lacks schema scope — fall through to inference.
    }

    const records = await airtable.listRecords(token, { baseId, table, view, maxRecords: 25 });
    res.json({ source: 'inferred', views: [], fields: airtable.inferFields(records) });
  })
);

router.post(
  '/airtable/records',
  handle(async (req, res) => {
    const { baseId, table, view, limit = 10 } = req.body || {};
    if (!baseId || !table) return res.status(400).json({ error: 'Base ID and table are required.' });
    const records = await airtable.listRecords(airtableToken(req.body), {
      baseId,
      table,
      view,
      maxRecords: limit,
    });
    res.json({ records });
  })
);

/* -------------------------------------------------------------- Kylas --- */

router.post(
  '/kylas/whoami',
  handle(async (req, res) => {
    const user = await kylas.whoami({ apiKey: kylasKey(req.body), baseUrl: kylasUrl(req.body) });
    res.json({ user });
  })
);

router.post(
  '/kylas/fields',
  handle(async (req, res) => {
    const { entity } = req.body || {};
    const fields = await kylas.listFields(
      { apiKey: kylasKey(req.body), baseUrl: kylasUrl(req.body) },
      entity
    );
    res.json({ entity, fields });
  })
);

/* --------------------------------------------------------------- Sync --- */

router.post(
  '/sync/csv-to-airtable',
  handle(async (req, res) => {
    const report = await csvToAirtable({ ...req.body, token: airtableToken(req.body) });
    res.json(report);
  })
);

router.post(
  '/sync/airtable-to-kylas',
  handle(async (req, res) => {
    const report = await airtableToKylas({
      ...req.body,
      token: airtableToken(req.body),
      apiKey: kylasKey(req.body),
      baseUrl: kylasUrl(req.body),
    });
    res.json(report);
  })
);

export default router;
