/**
 * Netlify Function: the same /api/track and /api/health that `node server.js` serves locally.
 *
 * The courier logic is shared with server.js through ../../relay.js, so both return identical JSON
 * (see README for the response shape). Netlify bundles relay.js into the function at deploy time.
 *
 * The page and this function are on the same site, so no CORS headers are needed. The page calls
 * /api/track?awb=… (the path is declared in `config` below, so no redirect rule is required).
 */
import relay from '../../relay.js';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported.' } });
  }
  const url = new URL(req.url);
  if (url.pathname === '/api/health') return json(200, { ok: true, upstream: relay.UPSTREAM });

  const { status, body } = await relay.trackRequest(url.searchParams.get('awb'));
  return json(status, body);
};

export const config = { path: ['/api/track', '/api/health'] };
