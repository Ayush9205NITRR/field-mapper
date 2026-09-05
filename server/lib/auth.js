/**
 * Password gate for hosted deployments.
 *
 * A hosted instance holds live Airtable and Kylas credentials and can write to
 * a CRM, so the URL alone must not be enough to use it. When APP_PASSWORD is
 * set every request needs HTTP Basic credentials; over HTTPS (which every
 * managed host terminates for you) that is enough to keep the instance private
 * without adding session storage or a login page.
 */
import crypto from 'node:crypto';

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Still hash both so the comparison cost does not leak the length.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * Express middleware. A no-op when APP_PASSWORD is unset, which is the normal
 * case for `npm start` on your own machine.
 */
export function passwordGate({ password, username = 'admin', skip = [] } = {}) {
  if (!password) return (_req, _res, nextFn) => nextFn();

  return (req, res, nextFn) => {
    if (skip.includes(req.path)) return nextFn();

    const header = req.get('authorization') || '';
    const [scheme, encoded] = header.split(' ');

    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const user = decoded.slice(0, separator);
      const pass = decoded.slice(separator + 1);
      // Evaluate both so a wrong username costs the same as a wrong password.
      const userOk = safeEqual(user, username);
      const passOk = safeEqual(pass, password);
      if (userOk && passOk) return nextFn();
    }

    res.set('WWW-Authenticate', 'Basic realm="Field Mapper", charset="UTF-8"');
    res.status(401).type('text/plain').send('Authentication required.');
  };
}

/**
 * Refuse to boot a public instance with no password.
 *
 * Returns an error message instead of throwing so the caller decides what to
 * do with it. Local development is unaffected.
 */
export function checkDeploymentSafety(env = process.env) {
  const isHosted =
    env.NODE_ENV === 'production' ||
    Boolean(env.RENDER || env.RAILWAY_ENVIRONMENT || env.FLY_APP_NAME || env.DYNO);

  if (!isHosted) return null;
  // A value that is only whitespace is not a password.
  if ((env.APP_PASSWORD || '').trim()) return null;

  return (
    'Refusing to start: this instance is reachable over the internet and holds ' +
    'credentials that can write to your CRM, but APP_PASSWORD is not set.\n' +
    'Set APP_PASSWORD in your host\'s environment variables and redeploy.\n' +
    'To run without a password anyway (not recommended), set ALLOW_PUBLIC=true.'
  );
}
