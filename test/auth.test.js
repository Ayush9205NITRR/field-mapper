import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordGate, checkDeploymentSafety } from '../server/lib/auth.js';

/** Minimal Express-shaped req/res doubles. */
function run(middleware, { path = '/', authorization } = {}) {
  const result = { nexted: false, status: null, headers: {}, body: null };
  const req = { path, get: (name) => (name.toLowerCase() === 'authorization' ? authorization : undefined) };
  const res = {
    set(name, value) { result.headers[name] = value; return res; },
    status(code) { result.status = code; return res; },
    type() { return res; },
    send(body) { result.body = body; return res; },
  };
  middleware(req, res, () => { result.nexted = true; });
  return result;
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('no password configured means the gate is a no-op', () => {
  assert.equal(run(passwordGate({}), {}).nexted, true);
});

test('correct credentials pass through', () => {
  const gate = passwordGate({ password: 's3cret', username: 'admin' });
  assert.equal(run(gate, { authorization: basic('admin', 's3cret') }).nexted, true);
});

test('wrong password, wrong user and missing header are all rejected', () => {
  const gate = passwordGate({ password: 's3cret', username: 'admin' });
  for (const authorization of [
    basic('admin', 'wrong'),
    basic('someone', 's3cret'),
    basic('admin', ''),
    'Bearer token',
    undefined,
  ]) {
    const result = run(gate, { authorization });
    assert.equal(result.nexted, false, `should reject: ${authorization}`);
    assert.equal(result.status, 401);
    assert.match(result.headers['WWW-Authenticate'], /^Basic realm=/);
  }
});

test('a password of a different length is rejected without throwing', () => {
  const gate = passwordGate({ password: 'short', username: 'admin' });
  assert.equal(run(gate, { authorization: basic('admin', 'a-much-longer-guess') }).nexted, false);
});

test('a password containing a colon still works', () => {
  const gate = passwordGate({ password: 'pa:ss:word', username: 'admin' });
  assert.equal(run(gate, { authorization: basic('admin', 'pa:ss:word') }).nexted, true);
});

test('the health check is reachable without credentials', () => {
  const gate = passwordGate({ password: 's3cret', skip: ['/health'] });
  assert.equal(run(gate, { path: '/health' }).nexted, true);
  assert.equal(run(gate, { path: '/' }).nexted, false);
});

test('a hosted instance with no password is refused', () => {
  for (const env of [
    { NODE_ENV: 'production' },
    { RENDER: 'true' },
    { RAILWAY_ENVIRONMENT: 'production' },
    { FLY_APP_NAME: 'field-mapper' },
  ]) {
    assert.match(checkDeploymentSafety(env), /APP_PASSWORD is not set/);
  }
});

test('a hosted instance with a password boots, and local dev is unaffected', () => {
  assert.equal(checkDeploymentSafety({ NODE_ENV: 'production', APP_PASSWORD: 'x' }), null);
  assert.equal(checkDeploymentSafety({}), null);
});

test('a password pasted with a trailing newline still authenticates', () => {
  // Host dashboards commonly store the value verbatim, newline included.
  process.env.APP_PASSWORD = 'S2DvPNKF\n';
  const configured = (process.env.APP_PASSWORD ?? '').trim();
  const gate = passwordGate({ password: configured, username: 'admin' });
  assert.equal(run(gate, { authorization: basic('admin', 'S2DvPNKF') }).nexted, true);
  delete process.env.APP_PASSWORD;
});

test('a whitespace-only password does not count as set', () => {
  assert.match(checkDeploymentSafety({ NODE_ENV: 'production', APP_PASSWORD: '  \n' }), /not set/);
});
