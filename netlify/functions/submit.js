'use strict';
/**
 * /api/submit  — receives the completed form submission, builds the PDF,
 * optionally archives the unsigned copy to Google Drive, then sends it for
 * signature via DocuSign. Returns the envelope id/status.
 *
 * Expected POST body (from the form's submit handler):
 * {
 *   signer1: { name, email },          // applicant one (required)
 *   signer2: { name, email },          // applicant two (optional)
 *   a1: { address, suburb, city, postcode },
 *   assets: [ { label, detail, value } ],
 *   liabs:  [ { label, detail, value } ],
 *   loans:  [ { vals:[...] } ],
 *   fields: { ...all other keyed inputs... }
 * }
 */
const { buildPdf } = require('./lib/pdf');
const docusign = require('./lib/docusign');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });

  let sub;
  try { sub = JSON.parse(event.body || '{}'); } catch { return resp(400, { error: 'Bad JSON' }); }

  const s1 = sub.signer1 || {};
  if (!s1.email || !s1.name) {
    return resp(400, { error: 'Applicant one name and email are required to send for signing.' });
  }

  try {
    const pdf = await buildPdf(sub);

    // Optional: archive the unsigned submission to Drive.
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.ARCHIVE_UNSIGNED === 'true') {
      try {
        const { uploadPdf } = require('./lib/drive');
        const stamp = new Date().toISOString().slice(0, 10);
        await uploadPdf(pdf, `Statement of Position — ${s1.name} (${stamp}) — unsigned.pdf`);
      } catch (e) { console.error('Drive archive failed:', e.message); /* non-fatal */ }
    }

    const result = await docusign.sendForSignature(pdf, s1, sub.signer2);
    return resp(200, { ok: true, envelopeId: result.envelopeId, status: result.status });
  } catch (e) {
    console.error('submit error:', e);
    return resp(500, { error: 'Could not send for signature.', detail: String(e.message || e) });
  }
};

function resp(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
