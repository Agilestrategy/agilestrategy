'use strict';
/**
 * /api/form-list?key=... — adviser-only index of saved shared forms.
 * Requires env ADVISER_KEY; the key is chosen by the adviser and shared only
 * with the team (Paul + loan analyst). Returns ref, form, client, updated.
 */
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
  try { connectLambda(event); } catch (e) { /* newer runtimes configure automatically */ }
  const q = event.queryStringParameters || {};
  const key = String(q.key || '').trim();
  if (!process.env.ADVISER_KEY) return resp(500, { error: 'ADVISER_KEY env var is not set yet.' });
  if (!key || key !== process.env.ADVISER_KEY) return resp(401, { error: 'Invalid adviser key' });

  try {
    const store = getStore('sof-forms');
    const listing = await store.list();
    const blobs = (listing && listing.blobs) ? listing.blobs.slice(0, 300) : [];
    const out = [];
    for (const b of blobs) {
      try {
        const rec = await store.get(b.key, { type: 'json' });
        if (!rec) continue;
        const meta = rec.meta || {};
        out.push({
          ref: b.key,
          form: meta.form || 'asb',
          client: meta.client || '',
          updated: rec.updated || '',
          pinProtected: !!rec.pinHash
        });
      } catch (e) { /* skip unreadable */ }
    }
    out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    return resp(200, { ok: true, forms: out });
  } catch (e) {
    return resp(500, { error: 'List failed', detail: String(e.message || e) });
  }
};

function resp(code, obj) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
