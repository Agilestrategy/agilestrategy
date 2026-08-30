'use strict';
/**
 * /api/doc-extract — Smart Prefill document reader.
 * Accepts one uploaded document (PDF or image, base64) and returns structured
 * Statement of Financial Position data extracted by the Claude API.
 *
 * Body: {
 *   file: { name, mime, data },   // data = base64 (no data: prefix)
 *   context: {
 *     applicantName?, jointName?,   // helps attribute values to the right person
 *     refinance?: boolean           // true = add back interest on balance-sheet debt being refinanced
 *   }
 * For financial statements the function returns raw components (companies/shareholders/personalIncome);
 * the form renders a checkbox per director and computes the income for whoever the adviser ticks.
 * }
 *
 * Requires env var ANTHROPIC_API_KEY (set in Netlify → Site settings → Environment variables).
 */

const MODEL = 'claude-haiku-4-5'; // fast enough for Netlify's 10s function limit; swap to claude-sonnet-4-5 if the plan's timeout is ever raised
const MAX_B64 = 5 * 1024 * 1024; // ~3.7MB binary per file

const EXTRACT_TOOL = {
  name: 'sof_prefill',
  description: 'Report the structured data extracted from the document for pre-filling a NZ Statement of Financial Position.',
  input_schema: {
    type: 'object',
    properties: {
      docType: {
        type: 'string',
        enum: ['passport', 'drivers_licence', 'rating_notice', 'property_valuation', 'payslip', 'financial_statements', 'kiwisaver', 'investment', 'bank_statements', 'utility_bill', 'other'],
      },
      docDescription: { type: 'string', description: 'One line: what the document is, whose it is, what period it covers.' },
      applicant: {
        type: 'object',
        description: 'Details for the (primary) applicant, only if this document evidences them.',
        properties: {
          name: { type: 'string' }, dob: { type: 'string', description: 'YYYY-MM-DD' },
          address: { type: 'string' }, occupation: { type: 'string' }, employer: { type: 'string' },
          phone: { type: 'string' }, email: { type: 'string' },
        },
      },
      joint: {
        type: 'object',
        description: 'Same shape as applicant, for the joint applicant.',
        properties: {
          name: { type: 'string' }, dob: { type: 'string' }, address: { type: 'string' },
          occupation: { type: 'string' }, employer: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
        },
      },
      income: {
        type: 'object',
        description: 'All values MONTHLY NZ$ gross unless the field name says annual. Use who="app"|"joint" attribution via the two sub-objects.',
        properties: {
          salaryMonthly: { type: 'object', properties: { app: { type: 'number' }, joint: { type: 'number' } } },
          rentMonthly: { type: 'object', properties: { app: { type: 'number' }, joint: { type: 'number' } } },
          interestDividendsMonthly: { type: 'object', properties: { app: { type: 'number' }, joint: { type: 'number' } } },
          selfEmployedMonthly: { type: 'object', properties: { app: { type: 'number' }, joint: { type: 'number' } } },
          otherMonthly: { type: 'object', properties: { app: { type: 'number' }, joint: { type: 'number' } } },
          annualTotal: { type: 'object', properties: { app: { type: 'number' }, joint: { type: 'number' } } },
          shareholderSalaryAnnual: { type: 'number' },
          netProfitBeforeTaxAnnual: { type: 'number' },
          depreciationAddBackAnnual: { type: 'number' },
          interestAddBackAnnual: { type: 'number' },
          workings: { type: 'string', description: 'Plain-English working for any self-employed calculation: shareholder salaries + NPBT + 100% depreciation add-back (+ interest add-back only when refinancing). Show the numbers.' },
        },
      },
      kiwisaver: {
        type: 'object',
        properties: {
          appBalance: { type: 'number' }, jointBalance: { type: 'number' },
          appRatePct: { type: 'number' }, jointRatePct: { type: 'number' },
          provider: { type: 'string' },
        },
      },
      companies: {
        type: 'array',
        description: 'For financial statements / tax returns: one entry per trading company found. All figures ANNUAL from the P&L for the latest year.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            npbtAnnual: { type: 'number', description: 'Net profit before tax AFTER shareholder salaries were deducted (a loss is negative).' },
            depreciationAnnual: { type: 'number', description: 'Depreciation + amortisation expensed in the P&L. Search the expense lines and any fixed-asset schedule carefully; 0 only if genuinely nil.' },
            interestAnnual: { type: 'number', description: 'Interest expense in the P&L (used only when the adviser confirms a refinance).' },
            grossProfitAnnual: { type: 'number' },
          },
          required: ['name'],
        },
      },
      shareholders: {
        type: 'array',
        description: 'For financial statements / tax returns: every shareholder/director found, per company.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            company: { type: 'string' },
            ownershipPct: { type: 'number', description: '0-100' },
            shareholderSalaryAnnual: { type: 'number' },
          },
          required: ['name', 'company'],
        },
      },
      personalIncome: {
        type: 'array',
        description: 'From personal tax returns (IR3) or payslips inside the pack: per person, ANNUAL gross non-business income streams.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            employmentAnnual: { type: 'number' },
            interestDividendsAnnual: { type: 'number' },
            otherAnnual: { type: 'number' },
          },
          required: ['name'],
        },
      },
      properties: {
        type: 'array',
        description: 'Real estate evidenced by rating notices / valuations / EVals.',
        items: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            value: { type: 'number' },
            basis: { type: 'string', enum: ['Registered Valuation', 'Council Valuation', 'EVal', 'Estimation', 'Other'] },
          },
          required: ['address'],
        },
      },
      otherAssets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['deposits_investments', 'life_super', 'motor_vehicle', 'other_vehicle', 'furniture_effects', 'livestock', 'other'] },
            description: { type: 'string' },
            value: { type: 'number' },
          },
          required: ['category', 'description', 'value'],
        },
      },
      liabilities: {
        type: 'array',
        description: 'Debts evidenced in the document (mortgages, loans, cards, HPs).',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['Mortgage', 'Overdraft', 'Personal loan', 'Credit / store card', 'Hire purchase', 'Student loan', 'Overdue account', 'Other'] },
            facility: { type: 'string', enum: ['Revolving', 'Term', 'Other', ''] },
            institution: { type: 'string' },
            balance: { type: 'number' },
            limit: { type: 'number' },
            payment: { type: 'number' },
            freq: { type: 'string', enum: ['Weekly', 'Fortnightly', 'Monthly', 'Annually'] },
          },
          required: ['type'],
        },
      },
      fixedCommitments: {
        type: 'array',
        description: 'Only these labels: "Rent or board payments", "Hire purchase payments", "Body corporate fees", "Child support / maintenance", "Lease / ground rent", "KiwiSaver".',
        items: { type: 'object', properties: { label: { type: 'string' }, amount: { type: 'number' }, freq: { type: 'string', enum: ['Weekly', 'Fortnightly', 'Monthly', 'Annually'] } }, required: ['label', 'amount'] },
      },
      expenses: {
        type: 'array',
        description: 'Only these labels: "Food", "Utilities", "Rates", "Transport", "Ongoing household expenses", "Childcare", "Healthcare / medical", "Personal care & clothing", "Public education", "Private education", "Other non-discretionary". Average recurring spend from bank statements.',
        items: { type: 'object', properties: { label: { type: 'string' }, amount: { type: 'number' }, freq: { type: 'string', enum: ['Weekly', 'Fortnightly', 'Monthly', 'Annually'] } }, required: ['label', 'amount'] },
      },
      notes: { type: 'array', items: { type: 'string' }, description: 'Anything the adviser should verify: assumptions, unreadable figures, statement periods, whose name a document is in.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['docType', 'docDescription', 'confidence'],
  },
};

function systemPrompt(ctx) {
  const names = [];
  if (ctx.applicantName) names.push('Primary applicant: ' + ctx.applicantName);
  if (ctx.jointName) names.push('Joint applicant: ' + ctx.jointName);
  return [
    'You extract data from client documents for a New Zealand mortgage adviser\'s Statement of Financial Position. Report ONLY via the sof_prefill tool. Never invent values — omit anything not clearly evidenced, and flag uncertainty in notes.',
    names.length ? names.join('. ') + '. Attribute values to app/joint by matching document names to these; if you cannot tell, use app and add a note.' : 'No applicant names supplied: attribute to app and note the name found on the document.',
    'Rules:',
    '- MONTHLY income figures are always the income used, gross, ÷ 12 for that individual — each row of the monthly income table is that income stream\'s annual gross ÷ 12. annualTotal is the full calculated gross annual income for that individual.',
    '- Payslips: gross salary annual ÷ 12 → income.salaryMonthly; capture employer/occupation. KiwiSaver contribution rate: use the rate the payslip states (typically 3%; flag in notes if over 4% — that is unusual). NEVER report a KiwiSaver balance from a payslip.',
    '- Company/business financial statements and tax returns: DO NOT fill income.selfEmployedMonthly or income.annualTotal — the adviser picks which directors are on the application in the form, and the form computes their income. Instead report the raw components completely: companies[] (NPBT, depreciation — search P&L expense lines and fixed-asset schedules hard for depreciation/amortisation, interest, gross profit), shareholders[] (every shareholder with company, ownership %, shareholder salary), and personalIncome[] (per person, from IR3s/payslips in the pack: employment, interest/dividends, other — annual gross). Show the full arithmetic per person in income.workings: shareholder salary + ownership % of (NPBT + 100% depreciation add-back'
      + (ctx.refinance ? ' + interest on debt being refinanced (refinance confirmed by adviser)' : '; the adviser has NOT confirmed a refinance, so exclude interest')
      + '), across every company, plus personal streams. KiwiSaver rate for self-employed defaults to 3 (kiwisaver.appRatePct/jointRatePct) unless a document states otherwise. NEVER report a KiwiSaver balance from financial statements or tax returns.',
    '- From financial statements, also estimate rough asset values into otherAssets (say "rough estimate" in the description): (a) the business itself, category "other", value ≈ 3 × the company\'s gross profit; (b) plant/equipment/vehicles under 5 years old, at original book (cost) value, in their proper categories. Never list KiwiSaver as an asset.',
    '- NEVER report tax owing (terminal/provisional/GST) as a liability — the adviser supplies tax separately. Put tax obligations and due dates in notes instead.',
    '- Bank statements (bankstatements.com.au reports or raw statements): identify mortgage/loan payments → liabilities (with institution and payment frequency); average recurring spending into the allowed expense labels; rent/board, HP, body corporate, child support, lease and KiwiSaver contributions into fixedCommitments. Note the statement period used for averages and any savings balances (notes only — never as deposits or assets).',
    '- KiwiSaver balances come ONLY from actual KiwiSaver/investment statements: balances → kiwisaver fields (never otherAssets); note the provider. Other investment (non-KiwiSaver) statements → otherAssets deposits_investments.',
    '- Passport/driver licence: full legal name and DOB only (licence may also give address). Note the expiry if lapsed.',
    '- Rating notices / valuations / Cotality EVals: property address and value with the right basis (rating notice = Council Valuation; Cotality = EVal; registered valuer = Registered Valuation).',
    '- Utility bills: address (and name) only.',
    'Amounts are plain numbers, no $ signs or commas. Dates YYYY-MM-DD.',
  ].join('\n');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return resp(500, { error: 'Document reading is not configured yet (missing ANTHROPIC_API_KEY).' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return resp(400, { error: 'Bad JSON' }); }
  const f = body.file || {};
  if (!f.data || typeof f.data !== 'string') return resp(400, { error: 'Missing file data' });
  if (f.data.length > MAX_B64) return resp(413, { error: 'File too large — keep each document under ~3.5MB. Tip: photos of documents can be resized before uploading.' });
  const mime = String(f.mime || '').toLowerCase();
  const ctx = (body.context && typeof body.context === 'object') ? body.context : {};

  let block;
  if (mime === 'application/pdf') {
    block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } };
  } else if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(mime) !== -1) {
    block = { type: 'image', source: { type: 'base64', media_type: mime, data: f.data } };
  } else {
    return resp(415, { error: 'Unsupported file type (' + (mime || 'unknown') + '). Upload a PDF, JPG, PNG or WebP. iPhone HEIC photos: share as JPEG, or screenshot the document.' });
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        system: systemPrompt(ctx),
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'sof_prefill' },
        messages: [{
          role: 'user',
          content: [
            block,
            { type: 'text', text: 'Document filename: ' + String(f.name || 'upload') + '. Extract everything relevant for the Statement of Financial Position.' },
          ],
        }],
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      const msg = (j && j.error && j.error.message) || ('Claude API error (' + r.status + ')');
      return resp(502, { error: msg });
    }
    const tu = (j.content || []).filter(function (c) { return c.type === 'tool_use' && c.name === 'sof_prefill'; })[0];
    if (!tu || !tu.input) return resp(502, { error: 'No structured data returned — try a clearer copy of the document.' });
    return resp(200, { ok: true, extract: tu.input, usage: j.usage || null });
  } catch (e) {
    return resp(500, { error: 'Extraction failed', detail: String((e && e.message) || e) });
  }
};

function resp(code, obj) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
