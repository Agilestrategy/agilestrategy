'use strict';
/**
 * /api/form-load?ref=...&pin=... — returns a saved in-progress form.
 * If the form is PIN-protected, a matching pin must be supplied.
 * Responses: 200 { data }, 401 (pin required/incorrect), 404 (not found).
 */
const { getStore, connectLambda } = require('@netlify/blobs');
const crypto = require('crypto');

function hashPin(ref, pin) {
  return crypto.createHash('sha256').update(ref + ':' + pin).digest('hex');
}

exports.handler = async (event) => {
  try { connectLambda(event); } catch (e) { /* newer runtimes configure automatically */ }
  const q = event.queryStringParameters || {};
  const ref = String(q.ref || '').trim();
  const pin = q.pin ? String(q.pin).trim() : '';
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(ref)) return resp(400, { error: 'Invalid ref' });

  try {
    const store = getStore('sof-forms');
    const rec = await store.get(ref, { type: 'json' });
    if (!rec) return resp(404, { error: 'Not found' });
    if (rec.pinHash) {
      if (!pin || hashPin(ref, pin) !== rec.pinHash) return resp(401, { error: 'PIN required or incorrect' });
    }
    return resp(200, { data: rec.data, updated: rec.updated, pinProtected: !!rec.pinHash });
  } catch (e) {
    return resp(500, { error: 'Load failed', detail: String(e.message || e) });
  }
};

function resp(code, obj) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
