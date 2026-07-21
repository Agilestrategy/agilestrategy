'use strict';
/**
 * Google Drive upload — two auth modes, first configured wins:
 *
 * MODE A (recommended, no service-account key needed):
 *   GOOGLE_OAUTH_CLIENT_ID       OAuth client id (same one as dashboard sign-in)
 *   GOOGLE_OAUTH_CLIENT_SECRET   its secret
 *   GOOGLE_DRIVE_REFRESH_TOKEN   refresh token minted once for the adviser's own
 *                                Google account (files are owned by the adviser)
 *
 * MODE B (service account, if org policy allows key creation):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  full service-account JSON
 *
 * Both modes:
 *   GOOGLE_DRIVE_FOLDER_ID       target folder id
 */
const { google } = require('googleapis');
const { Readable } = require('stream');

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
  throw new Error('Google Drive is not configured (set OAuth refresh-token vars or service-account JSON).');
}

function driveConfigured() {
  const e = process.env;
  return !!((e.GOOGLE_OAUTH_CLIENT_ID && e.GOOGLE_OAUTH_CLIENT_SECRET && e.GOOGLE_DRIVE_REFRESH_TOKEN) || e.GOOGLE_SERVICE_ACCOUNT_JSON);
}

async function uploadPdf(buffer, filename) {
  const drive = driveClient();
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: process.env.GOOGLE_DRIVE_FOLDER_ID ? [process.env.GOOGLE_DRIVE_FOLDER_ID] : undefined
    },
    media: { mimeType: 'application/pdf', body: Readable.from(buffer) },
    fields: 'id, webViewLink',
    supportsAllDrives: true
  });
  return res.data;
}

module.exports = { uploadPdf, driveConfigured };
