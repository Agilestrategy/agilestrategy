'use strict';
/**
 * onboarding-save.js — files completed adviser onboarding records into Google Drive.
 *
 * Called by adviser-onboarding.html (first week induction checklist) and
 * adviser-quiz.html (key rules quiz). Writes a text summary and a CSV into:
 *
 *   On Boarding New Advisors  (Drive folder 1_ul8-iveND2HOmXJn1s52GN_RI7PFqLH)
 *
 * Uses the same Drive credentials as hours-save.js and the client form filing
 * (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET /
 *  GOOGLE_DRIVE_REFRESH_TOKEN, or GOOGLE_SERVICE_ACCOUNT_JSON).
 * No new environment variables are needed.
 *
 * Re-filing creates a fresh copy alongside the old one; the newest is current.
 */
const { google } = require('googleapis');
const { Readable } = require('stream');

// On Boarding New Advisors (created 12 Nov 2026, owned by paul.newton@)
const FOLDER_ID = process.env.ONBOARDING_FOLDER_ID || '1_ul8-iveND2HOmXJn1s52GN_RI7PFqLH';

// Curtain only, same idea as the hours pages. The real protection is that this
// endpoint can only WRITE small text files into one folder, never read.
const TEAM_WORD = process.env.ONBOARDING_TEAM_WORD || 'agile';
const KINDS = ['checklist', 'quiz'];

function driveClient() {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN, GOOGLE_SERVICE_ACCOUNT_JSON } = process.env;
  if (GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_DRIVE_REFRESH_TOKEN) {
    const auth = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN });
    return google.drive({ version: 'v3', auth });
  }
  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.JWT(
      creds.client_email, null,
      creds.private_key.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/drive.file']
    );
    return google.drive({ version: 'v3', auth });
  }
  return null;
}

exports.handler = async (event) => {
  const respond = (code, body) => ({
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return respond(400, { error: 'Bad JSON' }); }

  const { kind, team, files } = payload;

  if (team !== TEAM_WORD) return respond(403, { error: 'Wrong team word' });
  if (!KINDS.includes(kind)) return respond(400, { error: 'Unknown kind, expected checklist or quiz' });
  if (!Array.isArray(files) || !files.length) return respond(400, { error: 'No files supplied' });
  if (files.length > 3) return respond(400, { error: 'Too many files' });

  const drive = driveClient();
  if (!drive) return respond(503, { error: 'Drive is not configured on the server' });

  const saved = [];
  try {
    for (const f of files) {
      const name = String(f.name || '').replace(/[^\w.\- ()]/g, '').slice(0, 120);
      const content = String(f.content || '');
      if (!name || !content) continue;
      if (content.length > 200000) return respond(400, { error: 'File too large: ' + name });
      const mime = f.mime === 'text/csv' ? 'text/csv' : 'text/plain';
      const res = await drive.files.create({
        requestBody: { name, parents: [FOLDER_ID] },
        media: { mimeType: mime, body: Readable.from(Buffer.from(content, 'utf8')) },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true
      });
      saved.push(res.data);
    }
    if (!saved.length) return respond(400, { error: 'Nothing to save' });
    return respond(200, { ok: true, saved });
  } catch (e) {
    console.error('onboarding-save failed:', e.message);
    return respond(500, { error: 'Drive write failed. Try again, or use Print and Download instead.' });
  }
};
