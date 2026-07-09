'use strict';
/**
 * Cotality (CoreLogic NZ) property lookup — server-side proxy.
 * Keeps your Cotality key off the browser and avoids CORS issues.
 *
 * The client POSTs { query: "<address the user picked>" } and gets back a
 * normalised security-property object. The exact Cotality endpoint + response
 * shape depend on the product you're licensed for, so the request/parse below
 * is written to be swapped to your contract's fields — search for TODO.
 *
 * Required env vars:
 *   COTALITY_API_BASE   e.g. https://api-uat.corelogic.asia  (your contracted base)
 *   COTALITY_API_KEY    your secret key / token
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return resp(400, { error: 'Bad JSON' }); }
  const query = (body.query || '').trim();
  if (!query) return resp(400, { error: 'Missing address query' });

  const base = process.env.COTALITY_API_BASE;
  const key = process.env.COTALITY_API_KEY;
  if (!base || !key) return resp(503, { error: 'Property lookup is not configured yet.' });

  try {
    // TODO: replace path + auth header with your contracted Cotality endpoint.
    // Typical pattern: address match -> property id -> property detail.
    const url = base.replace(/\/$/, '') +
      '/property/nz/v2/properties.json?address=' + encodeURIComponent(query);

    const r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }
    });
    if (!r.ok) return resp(502, { error: 'Cotality lookup failed (' + r.status + ')' });
    const data = await r.json();

    // TODO: map to your contract's response. Best-effort generic mapping below.
    const p = (data && (data.property || (data.properties && data.properties[0]))) || data || {};
    const out = {
      matched: !!(p && (p.formattedAddress || p.address || p.propertyId)),
      address: p.formattedAddress || p.address || query,
      legalDescription: p.legalDescription || p.legal || '',
      titleReference: p.titleReference || p.title || '',
      propertyId: p.propertyId || p.id || ''
    };
    return resp(200, out);
  } catch (e) {
    return resp(500, { error: 'Lookup error', detail: String(e.message || e) });
  }
};

function resp(code, obj) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
