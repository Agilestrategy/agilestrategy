'use strict';
/**
 * hours-save.js — files completed weekly hours into Google Drive.
 *
 * Called by weekly-hours.html (WSFC) and theboombox-hours.html with the
 * week's hours CSV, expenses CSV and text summary. Writes them into:
 *
 *   Agile Forms - Customers ONLINE / Billable Hours / WSFC
 *   Agile Forms - Customers ONLINE / Billable Hours / The Boombox
 *
 * Uses the same Drive credentials as the client-form filing
 * (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET /
 *  GOOGLE_DRIVE_REFRESH_TOKEN, or GOOGLE_SERVICE_ACCOUNT_JSON).
 * No new environment variables are needed.
 *
 * Re-filing the same week creates a fresh copy alongside the old one;
 * the newest file is the current one.
 */
const { google } = require('googleapis');
const { Readable } = require('stream');

// Billable Hours folder ids (created 16 Aug 2026, owned by paul.newton@)
const FOLDERS = {
  wsfc:    '1opuq82MXmOobPepQPz8V2B7H1xQcPKWK', // Billable Hours / WSFC
  boombox: '1I66Z9Ifn9rmSuDEwkCVHsoyYk-pN-bOw'  // Billable Hours / The Boombox
};

// Same curtain as the WSFC team pages. Not a vault — the real protection is
// that this endpoint can only WRITE hour sheets into Paul's Drive, never read.
const TEAM_WORD = process.env.HOURS_TEAM_WORD || 'kontiki60';

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

  const { app, team, files } = payload;

  if (team !== TEAM_WORD) return respond(403, { error: 'Wrong team word' });
  const folderId = FOLDERS[app];
  if (!folderId) return respond(400, { error: 'Unknown app — expected wsfc or boombox' });
  if (!Array.isArray(files) || !files.length) return respond(400, { error: 'No files supplied' });
  if (files.length > 5) return respond(400, { error: 'Too many files' });

  const drive = driveClient();
  if (!drive) return respond(503, { error: 'Drive is not configured on the server' });

  const saved = [];
  try {
    for (const f of files) {
      const name = String(f.name || '').replace(/[^\w.\- ()]/g, '').slice(0, 120);
      const content = String(f.content || '');
      if (!name || !content) continue;
      if (content.length > 500000) return respond(400, { error: 'File too large: ' + name });
      const mime = f.mime === 'text/plain' ? 'text/plain' : 'text/csv';
      const res = await drive.files.create({
        requestBody: { name, parents: [folderId] },
        media: { mimeType: mime, body: Readable.from(Buffer.from(content, 'utf8')) },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true
      });
      saved.push(res.data);
    }
    if (!saved.length) return respond(400, { error: 'Nothing to save' });
    return respond(200, { ok: true, saved });
  } catch (e) {
    console.error('hours-save failed:', e.message);
    return respond(500, { error: 'Drive write failed — try again, or download the CSVs instead' });
  }
};
