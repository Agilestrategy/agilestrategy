'use strict';
/**
 * DocuSign helper — JWT Grant auth + envelope creation.
 * Uses the official `docusign-esign` SDK. All secrets come from env vars.
 *
 * Required env vars (see .env.example):
 *   DOCUSIGN_INTEGRATION_KEY   integration key / client id (GUID)
 *   DOCUSIGN_USER_ID           API username / user GUID that granted consent
 *   DOCUSIGN_RSA_PRIVATE_KEY   the full RSA private key (PEM, with \n newlines)
 *   DOCUSIGN_OAUTH_BASE        account-d.docusign.com (demo) | account.docusign.com (prod)
 *   DOCUSIGN_CC_NAME           you (countersigner / cc), e.g. "Paul Newton"
 *   DOCUSIGN_CC_EMAIL          your email
 */
const docusign = require('docusign-esign');

let cachedToken = null;       // { accessToken, accountId, basePath, expires }

async function getAuth() {
  if (cachedToken && cachedToken.expires > Date.now() + 60 * 1000) return cachedToken;

  const apiClient = new docusign.ApiClient();
  apiClient.setOAuthBasePath(process.env.DOCUSIGN_OAUTH_BASE); // domain only

  const key = (process.env.DOCUSIGN_RSA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const rsaKey = Buffer.from(key);
  const scopes = ['signature', 'impersonation'];

  const tokenRes = await apiClient.requestJWTUserToken(
    process.env.DOCUSIGN_INTEGRATION_KEY,
    process.env.DOCUSIGN_USER_ID,
    scopes,
    rsaKey,
    50 * 60 // token lifetime in seconds (max 60 min)
  );
  const accessToken = tokenRes.body.access_token;
  const expiresIn = tokenRes.body.expires_in || 3000;

  // discover the account base URI for this user
  const userInfo = await apiClient.getUserInfo(accessToken);
  const account = (userInfo.accounts || []).find(a => a.isDefault) || userInfo.accounts[0];
  if (!account) throw new Error('No DocuSign account found for this user.');

  cachedToken = {
    accessToken,
    accountId: account.accountId,
    basePath: account.baseUri + '/restapi',
    expires: Date.now() + expiresIn * 1000
  };
  return cachedToken;
}

function client(auth) {
  const c = new docusign.ApiClient();
  c.setBasePath(auth.basePath);
  c.addDefaultHeader('Authorization', 'Bearer ' + auth.accessToken);
  return c;
}

/**
 * Send a PDF for signing. Signature/date positions are located by anchor
 * strings embedded in the PDF (see lib/pdf.js): **signature_1**, **date_1**, etc.
 *
 * @param {Buffer} pdfBuffer   the generated Statement of Position PDF
 * @param {Object} signer1     { name, email }  (applicant one — required)
 * @param {Object} [signer2]   { name, email }  (applicant two — optional)
 * @returns {Promise<{envelopeId:string, status:string}>}
 */
async function sendForSignature(pdfBuffer, signer1, signer2) {
  const auth = await getAuth();
  const envelopesApi = new docusign.EnvelopesApi(client(auth));

  const doc = docusign.Document.constructFromObject({
    documentBase64: Buffer.from(pdfBuffer).toString('base64'),
    name: 'Statement of Position',
    fileExtension: 'pdf',
    documentId: '1'
  });

  function signerObj(person, idx) {
    const s = docusign.Signer.constructFromObject({
      email: person.email,
      name: person.name,
      recipientId: String(idx),
      routingOrder: String(idx)
    });
    s.tabs = docusign.Tabs.constructFromObject({
      signHereTabs: [docusign.SignHere.constructFromObject({
        anchorString: '**signature_' + idx + '**',
        anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-6'
      })],
      dateSignedTabs: [docusign.DateSigned.constructFromObject({
        anchorString: '**date_' + idx + '**',
        anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-6'
      })]
    });
    return s;
  }

  const signers = [signerObj(signer1, 1)];
  if (signer2 && signer2.email) signers.push(signerObj(signer2, 2));

  const recipients = docusign.Recipients.constructFromObject({ signers });

  if (process.env.DOCUSIGN_CC_EMAIL) {
    const ccOrder = signers.length + 1;
    recipients.carbonCopies = [docusign.CarbonCopy.constructFromObject({
      email: process.env.DOCUSIGN_CC_EMAIL,
      name: process.env.DOCUSIGN_CC_NAME || 'Adviser',
      recipientId: String(ccOrder),
      routingOrder: String(ccOrder)
    })];
  }

  const envelopeDefinition = docusign.EnvelopeDefinition.constructFromObject({
    emailSubject: 'Please sign your Statement of Position — Agile Strategy',
    documents: [doc],
    recipients,
    status: 'sent'
  });

  const result = await envelopesApi.createEnvelope(auth.accountId, { envelopeDefinition });
  return { envelopeId: result.envelopeId, status: result.status };
}

/** Download the completed (combined) PDF for an envelope — used by the webhook. */
async function getCombinedPdf(envelopeId) {
  const auth = await getAuth();
  const envelopesApi = new docusign.EnvelopesApi(client(auth));
  // returns the document bytes (string/Buffer depending on SDK build)
  const data = await envelopesApi.getDocument(auth.accountId, envelopeId, 'combined');
  return Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');
}

module.exports = { sendForSignature, getCombinedPdf, getAuth };
