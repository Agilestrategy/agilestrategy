'use strict';
/** /api/config — public, non-secret runtime config for the front-end. */
exports.handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || null,
    keyLogin: !!process.env.ADVISER_KEY
  })
});
