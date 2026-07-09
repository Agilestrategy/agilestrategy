'use strict';
/**
 * Google Drive upload via a service account (server-side, secret).
 * Used to archive submissions and/or signed PDFs into a Drive folder.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the full service-account JSON (stringified)
 *   GOOGLE_DRIVE_FOLDER_ID       target folder id (share the folder WITH the
 *                                service account email, or use a Shared Drive)
 *
 * NOTE: If you switch on DocuSign's native Google Drive connector instead,
 * signed PDFs are filed automatically and you only need this for the raw
 * (unsigned) submission archive — or not at all.
 */
const { google } = require('googleapis');
const { Readable } = require('stream');

function driveClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.JWT(
    creds.client_email, null,
    creds.private_key.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/drive.file']
  );
  return google.drive({ version: 'v3', auth });
}

/**
 * @param {Buffer} buffer   PDF bytes
 * @param {string} filename e.g. "Statement of Position — Smith.pdf"
 * @returns {Promise<{id:string, webViewLink:string}>}
 */
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

module.exports = { uploadPdf };
