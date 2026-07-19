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
  const auth = await checkAdviser(event, q);
  if (!auth.ok) return resp(401, { error: auth.error });

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

/** Adviser auth: Google ID token (preferred) or legacy ADVISER_KEY. */
async function checkAdviser(event, q) {
  // 1) Google Sign-In token
  const hdr = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : String(q.token || '').trim();
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  const allow = String(process.env.ADVISER_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (token && clientId) {
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
      if (r.ok) {
        const info = await r.json();
        const emailOk = info.email && info.email_verified === 'true' &&
          (allow.length ? allow.includes(String(info.email).toLowerCase()) : false);
        if (info.aud === clientId && emailOk) return { ok: true, email: info.email };
        if (info.aud !== clientId) return { ok: false, error: 'Google sign-in: wrong client id.' };
        return { ok: false, error: 'This Google account is not on the adviser list.' };
      }
    } catch (e) { /* fall through */ }
    return { ok: false, error: 'Google sign-in could not be verified.' };
  }
  // 2) Legacy shared key
  const key = String(q.key || '').trim();
  if (process.env.ADVISER_KEY && key && key === process.env.ADVISER_KEY) return { ok: true, email: 'key-login' };
  return { ok: false, error: 'Sign in with Google, or enter a valid adviser key.' };
}

function resp(code, obj) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
