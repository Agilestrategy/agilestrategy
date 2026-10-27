'use strict';
/**
 * /api/px  Email open tracking pixel for Agile Strategy.
 *
 * Used as the src of the signature logo (or an invisible pixel) in tracked emails:
 *   https://forms.agilestrategy.co.nz/api/px?id=<sendId>&t=<recipientToken>
 *   add &px=1 to return a transparent 1x1 GIF instead of the logo.
 *
 * On every hit it posts {id, t, ua, at} to the Google Apps Script web app that
 * writes the Email Tracking sheet, then serves the image. No data is stored here.
 *
 * Env vars (Netlify, Site settings, Environment variables):
 *   TRACK_WEBHOOK  = the Apps Script web app URL (ends in /exec)
 *   TRACK_SECRET   = shared secret, must match the Settings tab in the sheet
 *   TRACK_LOGO_URL = optional, logo to serve (defaults to the Agile Strategy logo)
 */

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const DEFAULT_LOGO = 'https://images.squarespace-cdn.com/content/v1/5d252aa1d59d530001a100d8/1565819697507-84URCKUQE0ZC1UM9NBFO/agile-logo.png';

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
};

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const id = String(q.id || '').slice(0, 64);
  const token = String(q.t || '').slice(0, 64);
  const ua = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '';

  if (id && process.env.TRACK_WEBHOOK) {
    try {
      await fetch(process.env.TRACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, t: token, ua: ua, at: new Date().toISOString(), secret: process.env.TRACK_SECRET || '' }),
        redirect: 'follow',
      });
    } catch (e) {
      // Never let logging failures break the image.
    }
  }

  if (q.px === '1') {
    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'image/gif', 'Content-Length': String(GIF.length) }, NO_CACHE),
      body: GIF.toString('base64'),
      isBase64Encoded: true,
    };
  }

  // Serve the logo so the signature image looks exactly as it always has.
  const logoUrl = process.env.TRACK_LOGO_URL || DEFAULT_LOGO;
  try {
    const r = await fetch(logoUrl);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      return {
        statusCode: 200,
        headers: Object.assign({ 'Content-Type': r.headers.get('content-type') || 'image/png', 'Content-Length': String(buf.length) }, NO_CACHE),
        body: buf.toString('base64'),
        isBase64Encoded: true,
      };
    }
  } catch (e) { /* fall through */ }
  return { statusCode: 302, headers: Object.assign({ Location: logoUrl }, NO_CACHE), body: '' };
};
