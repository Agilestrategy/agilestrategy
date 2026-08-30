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
        enum: ['passport', 'drivers_licence', 'rating_notice', 'property_valuation', 'payslip', 'employment_letter', 'rental_statement', 'financial_statements', 'kiwisaver', 'investment', 'bank_statements', 'insurance_summary', 'utility_bill', 'other'],
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
            homeOfficeAnnual: { type: 'number', description: 'Home office / use-of-home expense in the P&L (also "office at home", "home workspace"). An add-back like depreciation; 0 only if genuinely nil.' },
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
      insurance: {
        type: 'object',
        description: 'From insurance policy schedules / broker summaries (e.g. Blanket): the cover currently in place.',
        properties: {
          fireGeneral: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                insurer: { type: 'string' },
                type: { type: 'string', enum: ['House', 'Contents', 'House & contents', 'Landlord', 'Vehicle', 'Boat / marine', 'Business', 'Other'] },
                address: { type: 'string', description: 'Property address for house/contents/landlord cover.' },
                covered: { type: 'string', description: 'Vehicle/boat description (make, model, year) for vehicle-type cover.' },
                rego: { type: 'string' },
                excess: { type: 'number' },
                sumInsured: { type: 'number', description: 'Replacement value / sum insured (contents value for contents cover; insured value for vehicles).' },
                premium: { type: 'number' },
                freq: { type: 'string', enum: ['Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Annually'] },
              },
              required: ['insurer'],
            },
          },
          lifeHealth: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                person: { type: 'string' },
                insurer: { type: 'string' },
                coverType: { type: 'string', enum: ['Life', 'Trauma / critical illness', 'Income protection', 'Mortgage repayment cover', 'TPD', 'Health / medical', 'Other'] },
                amount: { type: 'number' },
                premium: { type: 'number' },
                freq: { type: 'string', enum: ['Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Annually'] },
              },
              required: ['insurer'],
            },
          },
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
    '- Payslips: ALWAYS the GROSS payment (never net/take-home): annualise the per-period gross (weekly ×52, fortnightly ×26, monthly ×12) then ÷ 12 → income.salaryMonthly; capture employer/occupation; match the employee name to the applicant/joint names. KiwiSaver contribution rate: the EMPLOYEE\'s own contribution %, NEVER the employer\'s (typically 3%; flag in notes if over 4% — that is unusual). NEVER report a KiwiSaver balance from a payslip. Childcare or child support deductions on the payslip → fixedCommitments with label "Child support / maintenance" at the payslip amount and its stated frequency.',
    '- Employment contracts / letters of offer (employment_letter): GROSS salary only — NET figures never count. Always state the document\'s date in docDescription and notes; when documents conflict, the most recently dated document\'s gross figure is the dominant one — say so in notes so the adviser can compare dates.',
    '- Rental statements / remittances from property managers (rental_statement): ALWAYS the GROSS actual rent (never the net after management fees): annualise the per-week/fortnight/month gross (×52 / ×26 / ×12) then ÷ 12 → income.rentMonthly for the owner (match names); note the gross basis, period covered, and the property address.',
    '- Company/business financial statements and tax returns: DO NOT fill income.selfEmployedMonthly or income.annualTotal — the adviser picks which directors are on the application in the form, and the form computes their income. Instead report the raw components completely: companies[] (NPBT, depreciation — search P&L expense lines and fixed-asset schedules hard for depreciation/amortisation, home office / use-of-home expense, interest, gross profit), shareholders[] (every shareholder with company, ownership %, shareholder salary), and personalIncome[] (per person, from IR3s/payslips in the pack: employment, interest/dividends, other — annual gross). Show the full arithmetic per person in income.workings: shareholder salary + ownership % of (NPBT + 100% depreciation add-back + home office / use-of-home add-back'
      + (ctx.refinance ? ' + interest on debt being refinanced (refinance confirmed by adviser)' : '; the adviser has NOT confirmed a refinance, so exclude interest')
      + '), across every company, plus personal streams. KiwiSaver rate for self-employed defaults to 3 (kiwisaver.appRatePct/jointRatePct) unless a document states otherwise. NEVER report a KiwiSaver balance from financial statements or tax returns.',
    '- From financial statements, also estimate rough asset values into otherAssets (say "rough estimate" in the description): plant/equipment/vehicles under 5 years old, at original book (cost) value, in their proper categories. Do NOT report the business itself as an asset — the form computes each applicant\'s share of business value (3 × gross profit × their shareholding) once the adviser ticks the directors; just make sure grossProfitAnnual is filled per company. Never list KiwiSaver as an asset.',
    '- Liabilities: the applicants\' PERSONAL debts (personal mortgages, credit/store cards, personal loans, HPs, overdrafts in their own names), PLUS genuine business finance facilities found in a company balance sheet that are owed to an EXTERNAL financier — hire purchases, equipment/vehicle finance, leases (e.g. UDC): include those with the right type and set institution to "<financier> — <company name> (business)" so they are clearly labelled business liabilities. NEVER report as a liability, under ANY type including Other: tax owing of any kind (terminal, provisional, GST, income tax), company overdrafts/loans with no external financier identified, shareholder current accounts, or inter-company balances — the adviser supplies tax separately; those go in notes (with due dates).',
    '- Fill `joint` ONLY for a person who is clearly the joint applicant on THIS application: their name matches the supplied joint applicant name, or the document is their own photo ID. Other people found in company documents (fellow shareholders, spouses on tax returns) belong in shareholders[]/personalIncome[]/notes — never in joint.',
    '- Bank statements (bankstatements.com.au reports or raw statements): identify mortgage/loan payments → liabilities (with institution and payment frequency) — but ONLY when an actual loan/mortgage account balance is visible in the report; a recurring payment to another bank with NO loan balance showing is an inter-bank transfer, not a debt — leave it out. Average recurring spending into the allowed expense labels; rent/board, HP, body corporate, child support, lease and KiwiSaver contributions into fixedCommitments. Note the statement period used for averages and any savings balances (notes only — never as deposits or assets).',
    '- Business bank accounts in the report (accounts in a company/Ltd name): take ONLY the business overdraft, business loans, and the current account balances — institution labelled "<bank> — <company> (business)" — and state clearly in notes which accounts are business accounts. Ignore business account day-to-day spending for the expense tables.',
    '- Missed/dishonoured payments: only flag ones owed to external institutions; a failed transfer between the client\'s own accounts is NOT noted.',
    '- If a bank report shows a KiwiSaver account balance, DO report it in the kiwisaver fields (with provider) and say in notes it came from the bank report.',
    '- NEVER fill applicant/joint personal details (names, addresses) from bank statements — section 1 details come only from photo ID or financial statements, and photo ID always takes precedence.',
    '- Many documents may be uploaded one after another: report fully what THIS document shows; the form de-duplicates against what is already entered.',
    '- KiwiSaver balances come ONLY from actual KiwiSaver/investment statements: balances → kiwisaver fields (never otherAssets); note the provider. Other investment (non-KiwiSaver) statements → otherAssets deposits_investments.',
    '- Passport/driver licence: full legal name and DOB only (licence may also give address). Note the expiry if lapsed. EACH ID is one applicant: report the person under applicant; if one file contains two people\'s IDs, put the second person under joint — the form routes each to the right applicant slot.',
    '- Rating notices / valuations / Cotality EVals: property address and value with the right basis (rating notice = Council Valuation; Cotality = EVal; registered valuer = Registered Valuation).',
    '- Insurance policy schedules and broker summaries (insurance_summary — e.g. from Blanket): report EVERY current cover into insurance.fireGeneral (insurer, cover type, property address, house/contents excess, replacement value / sum insured / contents value, vehicle description + rego + insured value, premium with its frequency) and insurance.lifeHealth (person covered, insurer, cover type, amount, premium, frequency). Match people to the applicant names.',
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

  const name = String(f.name || '').toLowerCase();
  const isText = ['text/html', 'text/plain', 'text/csv', 'application/xhtml+xml'].indexOf(mime) !== -1
    || /\.(html?|txt|csv)$/.test(name);
  let block;
  if (mime === 'application/pdf') {
    block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } };
  } else if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(mime) !== -1) {
    block = { type: 'image', source: { type: 'base64', media_type: mime, data: f.data } };
  } else if (isText) {
    let text;
    try { text = Buffer.from(f.data, 'base64').toString('utf8'); } catch (e) { return resp(400, { error: 'Could not decode the text file.' }); }
    // strip script/style noise from HTML so the budget goes on real content
    text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    if (text.length > 300000) text = text.slice(0, 300000) + '\n[...file truncated for length — note this in your notes if figures may be missing...]';
    block = { type: 'text', text: 'Contents of the uploaded file (HTML/text source — read the data out of the markup):\n\n' + text };
  } else {
    return resp(415, { error: 'Unsupported file type (' + (mime || 'unknown') + '). Upload a PDF, JPG, PNG, WebP, HTML, TXT or CSV. iPhone HEIC photos: share as JPEG, or screenshot the document.' });
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
