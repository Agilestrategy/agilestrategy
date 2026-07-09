'use strict';
/**
 * /api/docusign-webhook — receives DocuSign Connect notifications.
 * When an envelope reaches "completed", it downloads the signed (combined)
 * PDF and files it into your Google Drive folder.
 *
 * Configure a DocuSign Connect listener (Settings → Connect) pointing to:
 *   https://YOUR-DOMAIN/api/docusign-webhook
 * with JSON format and the "Envelope Signed/Completed" event enabled.
 *
 * Optional: set DOCUSIGN_CONNECT_HMAC_KEY and enable HMAC in Connect to verify
 * the payload signature (recommended for production).
 */
const docusign = require('./lib/docusign');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Bad JSON' }; }

  // DocuSign Connect (JSON) shape: { event, data: { envelopeId, envelopeSummary } }
  const status = (payload.event || payload.status || '').toLowerCase();
  const envelopeId = (payload.data && payload.data.envelopeId) || payload.envelopeId;
  if (!envelopeId) return { statusCode: 200, body: 'No envelope id; ignored' };

  const completed = status.includes('completed') || status.includes('signed');
  if (!completed) return { statusCode: 200, body: 'Not a completion event; ignored' };

  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const { uploadPdf } = require('./lib/drive');
      const pdf = await docusign.getCombinedPdf(envelopeId);
      const stamp = new Date().toISOString().slice(0, 10);
      const file = await uploadPdf(pdf, `Statement of Position — signed (${stamp}) — ${envelopeId}.pdf`);
      console.log('Signed PDF filed to Drive:', file.id);
    }
    return { statusCode: 200, body: 'OK' };
  } catch (e) {
    console.error('webhook error:', e);
    return { statusCode: 500, body: 'Webhook processing failed' };
  }
};
