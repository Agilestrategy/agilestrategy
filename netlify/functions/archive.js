'use strict';
/**
 * /api/archive — builds the form's PDF and files it straight into Google Drive.
 * No DocuSign involved: this is the adviser's "Save PDF to Drive" action.
 * Body: { docTitle, docSubtitle, report, client }
 * Requires env: GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_DRIVE_FOLDER_ID
 */
const { buildPdf } = require('./lib/pdf');
const { uploadPdf } = require('./lib/drive');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_DRIVE_FOLDER_ID) {
    return resp(500, { error: 'Google Drive is not configured yet (service account / folder id missing).' });
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return resp(400, { error: 'Bad JSON' }); }
  if (!body.report || !Array.isArray(body.report.sections)) return resp(400, { error: 'Missing report' });

  try {
    const sub = {
      docTitle: body.docTitle || 'Form',
      docSubtitle: body.docSubtitle || '',
      signer1: { name: body.client || '', email: '' },
      report: body.report
    };
    const pdf = await buildPdf(sub);
    const stamp = new Date().toISOString().slice(0, 10);
    const who = (body.client || 'Client').replace(/[^\w\s.\-']/g, '').trim() || 'Client';
    const name = `${sub.docTitle} — ${who} (${stamp}).pdf`;
    const file = await uploadPdf(Buffer.from(pdf), name);
    return resp(200, { ok: true, name, link: file.webViewLink || null });
  } catch (e) {
    return resp(500, { error: 'Archive failed', detail: String(e.message || e) });
  }
};

function resp(code, obj) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
