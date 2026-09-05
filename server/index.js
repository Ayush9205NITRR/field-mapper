/**
 * Field Mapper server.
 *
 * Acts as a thin, credential-holding proxy in front of Airtable and Kylas so
 * that API keys never have to live in the browser and so every write goes
 * through the strict partial-update engine in server/lib.
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import apiRouter from './routes/api.js';
import { passwordGate, checkDeploymentSafety } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Minimal .env loader — avoids a dependency for a handful of values.
function loadEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!match) continue;
    const [, key, rawValue = ''] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2').trim();
  }
}
loadEnv();

const app = express();
app.disable('x-powered-by');
// Managed hosts terminate TLS in front of us; trust their forwarding headers
// so redirects and logged client IPs are correct.
app.set('trust proxy', 1);

// /health stays open so a host's uptime check does not need credentials.
app.use(
  passwordGate({
    password: process.env.APP_PASSWORD,
    username: process.env.APP_USERNAME || 'admin',
    skip: ['/health'],
  })
);

// CSV files are sent as text in the JSON body, so allow a generous limit.
app.use(express.json({ limit: '50mb' }));

app.use('/api', apiRouter);
app.use(express.static(path.join(root, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

// JSON error handler so the UI always gets a readable message.
app.use((error, _req, res, _next) => {
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
  res.status(status).json({ error: error.message || 'Unexpected server error' });
});

const port = Number(process.env.PORT) || 3000;

if (process.env.NODE_ENV !== 'test') {
  const unsafe = checkDeploymentSafety();
  if (unsafe && process.env.ALLOW_PUBLIC !== 'true') {
    console.error(`\n${unsafe}\n`);
    process.exit(1);
  }
  if (unsafe) console.warn('\nWARNING: running publicly with no password.\n');

  // Bind on all interfaces so container platforms can reach the process.
  app.listen(port, '0.0.0.0', () => {
    const locked = process.env.APP_PASSWORD ? 'password protected' : 'no password (local use)';
    console.log(`Field Mapper listening on port ${port} - ${locked}`);
  });
}

export default app;
