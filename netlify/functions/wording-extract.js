'use strict';
/**
 * /api/wording-extract — Smart Reader for the Policy Wording Comparison tool.
 * Accepts ONE policy document (PDF/image/text, base64) OR a URL to policy
 * wording online, and returns per-benefit wording extracts to populate the
 * comparison fields.
 *
 * Body: {
 *   file?: { name, mime, data },      // data = base64 (no data: prefix)
 *   url?:  "https://...",             // alternative to file: fetch wording online
 *   side:  "current" | "proposed",    // which column this document belongs to
 *   benefits?: ["Life cover", ...]    // benefit row names already on screen, for matching
 * }
 *
 * Requires env var ANTHROPIC_API_KEY (already set for /api/doc-extract).
 */

const MODEL = 'claude-haiku-4-5';
const MAX_B64 = 5 * 1024 * 1024; // ~3.7MB binary

const EXTRACT_TOOL = {
  name: 'wording_extract',
  description: 'Report the policy wording extracted from an insurance policy document, benefit by benefit, for a like-for-like wording comparison.',
  input_schema: {
    type: 'object',
    properties: {
      docDescription: { type: 'string', description: 'One line: what the document is (insurer, product, dated when).' },
      policy: {
        type: 'object',
        properties: {
          insurer: { type: 'string' },
          product: { type: 'string' },
          policyNumber: { type: 'string' },
        },
      },
      suite: { type: 'string', enum: ['life_health', 'fire_general', 'mixed', 'unknown'], description: 'Which suite this document covers: life/health cover, fire & general (house/contents/vehicle/liability), or both.' },
      benefits: {
        type: 'array',
        description: 'One entry per benefit/cover section found in the document.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The benefit name, matched to one of the supplied on-screen row names when it clearly refers to the same cover; otherwise the standard NZ name for it.' },
            wording: { type: 'string', description: 'The decision-relevant wording for this benefit, quoted or tightly paraphrased from the document: the operative definition, when it pays, key exclusions, stand-down/qualification periods, and any sum insured basis. Max ~150 words.' },
            note: { type: 'string', description: 'Optional one-liner the adviser should check (ambiguity, cross-reference to another section, unreadable text).' },
          },
          required: ['name', 'wording'],
        },
      },
      notes: { type: 'array', items: { type: 'string' }, description: 'Anything the adviser should verify: document date/version, sections not readable, benefits mentioned but not defined here.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['docDescription', 'benefits', 'confidence'],
  },
};

function systemPrompt(side, benefitNames) {
  return [
    'You extract POLICY WORDING from insurance policy documents (policy wordings, schedules, product brochures) for a licensed New Zealand financial adviser preparing a like-for-like replacement comparison. Report ONLY via the wording_extract tool.',
    'This document is the ' + (side === 'proposed' ? 'PROPOSED (new) policy' : 'CURRENT (existing) policy') + '.',
    benefitNames && benefitNames.length
      ? 'The adviser\'s comparison already has these benefit rows: ' + benefitNames.join(' | ') + '. When a section of the document is the same cover as one of these rows, use EXACTLY that row name so it lands in the right field. Benefits in the document with no matching row keep their own standard name.'
      : 'No benefit rows supplied: use standard NZ benefit names (e.g. "Life cover", "Trauma / critical conditions", "Income / mortgage protection", "House / buildings", "Contents", "Private vehicle").',
    'Rules:',
    '- Quote the operative wording, do not summarise it away: the definition that triggers a claim, key exclusions, stand-down / qualification / survival periods, sum insured basis (replacement vs indemnity vs agreed value), and excesses for fire & general covers.',
    '- Never invent wording. If a benefit is listed in a schedule but its wording is not in this document, report it with wording "Listed in schedule — full wording not in this document" and flag it in notes.',
    '- Keep each benefit\'s wording under ~150 words: the clauses that decide whether cover is broader or narrower, not boilerplate.',
    '- Fire & general documents: report each cover section (house/buildings, contents, vehicle, landlord, business assets/interruption, liability) as its own benefit, and include the excess and sum insured basis in its wording.',
    '- Capture insurer, product name and policy number into policy{} when shown.',
    '- If the document is not an insurance policy document at all, return an empty benefits array and say what it is in notes.',
  ].join('\n');
}

async function fetchUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That does not look like a valid link.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http/https links are supported.');
  const r = await fetch(u.toString(), {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; AgileStrategyWordingReader/1.0)' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error('Could not fetch the link (' + r.status + '). If the wording is behind a login, download the PDF and drop it in instead.');
  const ctype = String(r.headers.get('content-type') || '').toLowerCase();
  if (ctype.indexOf('application/pdf') !== -1) {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 3.7 * 1024 * 1024) throw new Error('That PDF is too large to read from a link — download it and drop it in (under ~3.5MB).');
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } };
  }
  let text = await r.text();
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  if (text.length > 300000) text = text.slice(0, 300000) + '\n[...page truncated for length — note this if wording may be missing...]';
  return { type: 'text', text: 'Contents of the web page at ' + u.toString() + ' (HTML/text source — read the wording out of the markup):\n\n' + text };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return resp(500, { error: 'The reader is not configured yet (missing ANTHROPIC_API_KEY).' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return resp(400, { error: 'Bad JSON' }); }
  const side = body.side === 'proposed' ? 'proposed' : 'current';
  const benefitNames = Array.isArray(body.benefits) ? body.benefits.filter(function (b) { return typeof b === 'string' && b.trim(); }).slice(0, 40) : [];

  let block, sourceLabel;
  if (body.url) {
    try { block = await fetchUrl(String(body.url)); } catch (e) { return resp(400, { error: String((e && e.message) || e) }); }
    sourceLabel = 'Web page: ' + String(body.url);
  } else {
    const f = body.file || {};
    if (!f.data || typeof f.data !== 'string') return resp(400, { error: 'Missing file data' });
    if (f.data.length > MAX_B64) return resp(413, { error: 'File too large — keep each document under ~3.5MB.' });
    const mime = String(f.mime || '').toLowerCase();
    const name = String(f.name || '').toLowerCase();
    const isText = ['text/html', 'text/plain', 'text/csv', 'application/xhtml+xml'].indexOf(mime) !== -1 || /\.(html?|txt|csv)$/.test(name);
    if (mime === 'application/pdf') {
      block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } };
    } else if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(mime) !== -1) {
      block = { type: 'image', source: { type: 'base64', media_type: mime, data: f.data } };
    } else if (isText) {
      let text;
      try { text = Buffer.from(f.data, 'base64').toString('utf8'); } catch (e) { return resp(400, { error: 'Could not decode the text file.' }); }
      text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
      if (text.length > 300000) text = text.slice(0, 300000) + '\n[...file truncated for length...]';
      block = { type: 'text', text: 'Contents of the uploaded file (HTML/text source):\n\n' + text };
    } else {
      return resp(415, { error: 'Unsupported file type (' + (mime || 'unknown') + '). Drop a PDF, JPG, PNG, WebP, HTML or TXT.' });
    }
    sourceLabel = 'Document filename: ' + String(f.name || 'upload');
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        system: systemPrompt(side, benefitNames),
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'wording_extract' },
        messages: [{
          role: 'user',
          content: [
            block,
            { type: 'text', text: sourceLabel + '. Extract the policy wording benefit by benefit for the ' + side + ' side of the comparison.' },
          ],
        }],
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      const msg = (j && j.error && j.error.message) || ('Claude API error (' + r.status + ')');
      return resp(502, { error: msg });
    }
    const tu = (j.content || []).filter(function (c) { return c.type === 'tool_use' && c.name === 'wording_extract'; })[0];
    if (!tu || !tu.input) return resp(502, { error: 'No structured wording returned — try a clearer copy of the document.' });
    return resp(200, { ok: true, extract: tu.input, usage: j.usage || null });
  } catch (e) {
    return resp(500, { error: 'Extraction failed', detail: String((e && e.message) || e) });
  }
};

function resp(code, obj) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
