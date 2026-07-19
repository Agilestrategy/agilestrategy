'use strict';
/**
 * /api/form-save — stores an in-progress form keyed by an unguessable `ref`.
 * Optional PIN protection: the first save with a `pin` sets it; later saves
 * and loads must supply the matching pin.
 * Body: { ref, data, pin? }
 */
const { getStore, connectLambda } = require('@netlify/blobs');
const crypto = require('crypto');

function hashPin(ref, pin) {
  return crypto.createHash('sha256').update(ref + ':' + pin).digest('hex');
}

exports.handler = async (event) => {
  try { connectLambda(event); } catch (e) { /* newer runtimes configure automatically */ }
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return resp(400, { error: 'Bad JSON' }); }
  const ref = String(body.ref || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(ref)) return resp(400, { error: 'Invalid ref' });
  if (typeof body.data !== 'object' || body.data === null) return resp(400, { error: 'Missing data' });
  const pin = body.pin ? String(body.pin).trim() : '';

  try {
    const store = getStore('sof-forms');
    const existing = await store.get(ref, { type: 'json' });

    let pinHash = existing && existing.pinHash ? existing.pinHash : null;
    if (pinHash) {
      if (!pin || hashPin(ref, pin) !== pinHash) return resp(401, { error: 'PIN required or incorrect' });
    } else if (pin) {
      pinHash = hashPin(ref, pin);
    }

    const meta = (body.meta && typeof body.meta === 'object') ? { form: String(body.meta.form || '').slice(0, 20), client: String(body.meta.client || '').slice(0, 80) } : (existing && existing.meta) || {};
    await store.setJSON(ref, { data: body.data, pinHash, meta, updated: new Date().toISOString() });
    return resp(200, { ok: true, pinProtected: !!pinHash });
  } catch (e) {
    return resp(500, { error: 'Save failed', detail: String(e.message || e) });
  }
};

function resp(code, obj) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
