'use strict';
/**
 * /api/property-lookup?q=<address> — Cotality (CoreLogic NZ) proxy.
 * Matches the address, then tries to fetch a current AVM estimate and legal/title detail.
 * Env vars:
 *   COTALITY_CLIENT_ID / COTALITY_CLIENT_SECRET   OAuth client credentials from Cotality
 *   COTALITY_API_BASE   optional, defaults to https://api.corelogic.asia
 * Response: { ok, summary, address, propertyId, estimate?, legal?, title? }
 */
const BASE = () => (process.env.COTALITY_API_BASE || 'https://api.corelogic.asia').replace(/\/$/, '');

let tokenCache = null;
async function getToken() {
  if (tokenCache && tokenCache.expires > Date.now() + 60000) return tokenCache.token;
  const id = process.env.COTALITY_CLIENT_ID, secret = process.env.COTALITY_CLIENT_SECRET;
  const basic = Buffer.from(id + ':' + secret).toString('base64');
  const r = await fetch(BASE() + '/access/oauth/token?grant_type=client_credentials', {
    method: 'POST', headers: { Authorization: 'Basic ' + basic }
  });
  if (!r.ok) throw new Error('Cotality auth failed (' + r.status + ')');
  const j = await r.json();
  tokenCache = { token: j.access_token, expires: Date.now() + (Number(j.expires_in || 3600) * 1000) };
  return tokenCache.token;
}

async function cget(path, token) {
  const r = await fetch(BASE() + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

exports.handler = async (event) => {
  const q = String((event.queryStringParameters && event.queryStringParameters.q) || '').trim();
  if (!q) return resp(400, { error: 'Missing address (q)' });
  if (!process.env.COTALITY_CLIENT_ID || !process.env.COTALITY_CLIENT_SECRET) {
    return resp(500, { error: 'Cotality is not configured yet (client id/secret missing).' });
  }
  try {
    const token = await getToken();
    // 1) Address match
    const match = await cget('/search/nz/matcher/address?q=' + encodeURIComponent(q), token);
    const m = match && (match.matchDetails || match.match || (Array.isArray(match.suggestions) && match.suggestions[0]) || match);
    const propertyId = m && (m.propertyId || m.property_id || m.id);
    const matchedAddress = (m && (m.propertyAddress || m.address || m.suggestion)) || q;
    if (!propertyId) return resp(404, { error: 'Cotality could not match that address.' });

    // 2) Best-effort extras (endpoints vary by subscription — each is optional)
    const out = { ok: true, propertyId, address: matchedAddress };
    const avm = await cget('/avm/nz/properties/' + propertyId + '/avm/intellival/consumer/current', token);
    if (avm) {
      const v = avm.valuation || avm;
      if (v && (v.estimate || v.estimatedValue)) out.estimate = v.estimate || v.estimatedValue;
      if (v && v.lowEstimate) out.estimateRange = v.lowEstimate + ' – ' + v.highEstimate;
    }
    const legal = await cget('/property-details/nz/properties/' + propertyId + '/legal', token);
    if (legal) {
      const l = (Array.isArray(legal.legalDescription) && legal.legalDescription[0]) || legal;
      if (l && (l.legalDescription || l.description)) out.legal = l.legalDescription || l.description;
    }
    const title = await cget('/property-details/nz/properties/' + propertyId + '/title', token);
    if (title) {
      const t = (Array.isArray(title.titles) && title.titles[0]) || title;
      if (t && (t.titleReference || t.reference)) out.title = t.titleReference || t.reference;
    }
    const bits = ['Matched: ' + matchedAddress];
    if (out.estimate) bits.push('AVM estimate: $' + Number(out.estimate).toLocaleString('en-NZ'));
    if (out.title) bits.push('Title: ' + out.title);
    if (out.legal) bits.push(out.legal);
    out.summary = bits.join(' · ');
    return resp(200, out);
  } catch (e) {
    return resp(502, { error: 'Cotality lookup failed', detail: String(e.message || e) });
  }
};

function resp(code, obj) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
