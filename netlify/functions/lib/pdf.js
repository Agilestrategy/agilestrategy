'use strict';
/**
 * Builds a complete, branded Statement of Position PDF that MIRRORS EVERY FIELD
 * the client filled in, from the `report` produced by the form's harvestForPdf().
 * pdf-lib only (pure JS). Signature/date locations use DocuSign anchor strings:
 *   **signature_1** **date_1**  (applicant one)   **signature_2** **date_2** (two)
 *
 * sub = {
 *   signer1:{name,email}, signer2:{name,email},
 *   report:{ sections:[ { n, title, blocks:[ ...typed blocks... ] } ] }
 * }
 * Block types: fields | money2 | money1 | income | loan | checklist | confirms
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const LOGO_B64 = require('./logo');

const GOLD = rgb(0.929, 0.773, 0.173);
const GOLD_SOFT = rgb(0.984, 0.945, 0.80);
const INK = rgb(0.10, 0.10, 0.10);
const MUTE = rgb(0.42, 0.42, 0.42);
const LINE = rgb(0.85, 0.85, 0.85);

const PAGE = [595.28, 841.89];
const M = 48;
const RIGHT = PAGE[0] - M;
const WIDTH = RIGHT - M;

// Fixed declarations text (same for every client) — rendered in the Declarations section.
const DECLARATIONS = [
  'I/We authorise that the information contained in this application form may be used by and relied on by the lending institutions listed below, including the lenders\u2019 respective Mortgage Guarantee Insurance Company and credit reference agencies.',
  'The broker does not charge me for these services unless specifically agreed in writing in advance, but receives a commission from the lender providing the loan. The broker is not an employee, agent, partner, nor joint venture partner of, nor does the broker act on behalf of, the lender. Personal information collected in this form is collected initially to assess my application for mortgage finance and may be given to a number of lenders at the broker\u2019s discretion. If my application is successful, the information will be used by the lender to administer the loan and by the lender and broker to administer any ongoing commission payments.',
  'I/we accept that the broker and lender might use my personal information for market research and to notify me of products or services that may be of interest, and that the lender may make the information available to its mortgage insurer, parties it proposes to contract with, any security trustee, and any assignee of the lender\u2019s rights (the recipients).',
  'I/We authorise the Broker, Lender and Recipients to collect personal information about me from third parties (including credit reporting agencies, banks and employers) and for those parties to disclose information to them; the Lender to disclose my information to the Broker during the loan term; disclosure to credit reporting agencies and to any third party making an authorised enquiry; and the use of credit reporting and monitoring services, including information about any default in my payment obligations.',
  'I/we understand that pursuant to the Privacy Act 2020 I have the right to request access to and correction of any personal information held by the broker or by the lender. I understand that I am not required by law to provide personal information, but failure to do so might prejudice my chances of obtaining finance.',
  'I understand that should my circumstances change before the loan is repaid, I am responsible for continuing to make loan repayments. In the event of my death, it will be my estate\u2019s responsibility to make the loan repayments and/or to pay off any loan balance.'
];

async function buildPdf(sub) {
  sub = sub || {};
  const report = sub.report || { sections: [] };

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await pdf.embedPng(Buffer.from(LOGO_B64, 'base64'));

  let page = pdf.addPage(PAGE);
  let y = PAGE[1] - M;

  const ctx = { pdf, font, bold, get page() { return page; } };
  function newPage() { page = pdf.addPage(PAGE); y = PAGE[1] - M; }
  function need(h) { if (y - h < M + 28) newPage(); }
  function S(t) {
    return String(t == null ? '' : t)
      .replace(/\u2248/g, '~').replace(/\u2265/g, '>=').replace(/\u2264/g, '<=')
      .replace(/\u2192/g, '->').replace(/\u2190/g, '<-').replace(/\u00a0/g, ' ');
  }
  function draw(str, x, yy, size, f, color) {
    page.drawText(S(str), { x, y: yy, size: size || 10, font: f || font, color: color || INK });
  }
  function wrap(str, f, size, maxW) {
    const words = S(str).split(/\s+/); const lines = []; let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w;
      if (f.widthOfTextAtSize(t, size) > maxW && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line); return lines.length ? lines : [''];
  }
  function rightW(str, f, size) { return f.widthOfTextAtSize(S(str), size); }

  // ---- masthead ----
  const lw = 118, lh = lw * (logo.height / logo.width);
  page.drawImage(logo, { x: M, y: y - lh + 6, width: lw, height: lh });
  draw(sub.docTitle || 'Statement of Position', RIGHT - 215, y - 12, 18, bold);
  draw(sub.docSubtitle || 'Loan application & asset / liability statement', RIGHT - 215, y - 28, 8, font, MUTE);
  draw('CONFIDENTIAL', RIGHT - 215, y - 42, 7, font, MUTE);
  y -= Math.max(lh, 50) + 6;
  page.drawRectangle({ x: M, y, width: WIDTH, height: 3, color: GOLD });
  y -= 22;

  function heading(n, title) {
    need(34);
    page.drawRectangle({ x: M, y: y - 5, width: 18, height: 18, color: GOLD });
    draw(n, M + 5, y, 11, bold);
    draw(title, M + 28, y, 13, bold);
    y -= 22;
  }
  function subhead(t) {
    if (!t) { y -= 4; return; }
    need(24);
    draw(t.toUpperCase(), M, y, 9, bold, rgb(0.6, 0.48, 0.05));
    y -= 6; page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.6, color: LINE }); y -= 13;
  }
  function kv(label, value) {
    const lblLines = wrap(label, font, 9, 150);
    const valLines = wrap(value, font, 9, WIDTH - 165);
    const rows = Math.max(lblLines.length, valLines.length);
    need(rows * 12 + 3);
    for (let i = 0; i < rows; i++) {
      if (lblLines[i]) draw(lblLines[i], M, y, 9, font, MUTE);
      if (valLines[i]) draw(valLines[i], M + 165, y, 9, font, INK);
      y -= 12;
    }
    y -= 3;
  }
  function moneyLine(label, value, isTotal) {
    need(15);
    const f = isTotal ? bold : font;
    const ll = wrap(label, f, 9, WIDTH - 110);
    draw(ll[0], M, y, 9, f, isTotal ? INK : INK);
    for (let i = 1; i < ll.length; i++) { y -= 11; need(11); draw(ll[i], M, y, 9, f, INK); }
    const v = value ? '$' + value : '';
    draw(v, RIGHT - rightW(v, f, 9), y, 9, f, INK);
    y -= 13;
    if (isTotal) { page.drawLine({ start: { x: M, y: y + 7 }, end: { x: RIGHT, y: y + 7 }, thickness: 0.9, color: GOLD }); y -= 2; }
  }

  function blockFields(b) {
    subhead(b.sub);
    b.rows.forEach(r => kv(r.label, r.value));
    y -= 2;
  }
  function blockMoney2(b) {
    subhead(b.sub || b.title);
    b.rows.forEach(r => moneyLine(r.label + (r.detail ? '  \u2014  ' + r.detail : ''), r.value));
    moneyLine(b.totalLabel, b.total, true);
    y -= 4;
  }
  function blockMoney1(b) {
    subhead(b.sub || b.title);
    b.rows.forEach(r => moneyLine(r.label, r.value));
    moneyLine(b.totalLabel, b.total, true);
    y -= 4;
  }
  function blockIncome(b) {
    subhead(b.sub || 'Annual gross income');
    need(16);
    draw('Applicant 1', RIGHT - 200 - rightW('Applicant 1', bold, 8) / 2, y, 8, bold, MUTE);
    draw('Applicant 2', RIGHT - rightW('Applicant 2', bold, 8), y, 8, bold, MUTE);
    y -= 13;
    b.rows.forEach(r => {
      need(13);
      draw(r.label, M, y, 9, font, INK);
      const v1 = r.a1 ? '$' + r.a1 : '', v2 = r.a2 ? '$' + r.a2 : '';
      draw(v1, RIGHT - 130 - rightW(v1, font, 9), y, 9, font, INK);
      draw(v2, RIGHT - rightW(v2, font, 9), y, 9, font, INK);
      y -= 12;
    });
    need(14);
    page.drawLine({ start: { x: M, y: y + 4 }, end: { x: RIGHT, y: y + 4 }, thickness: 0.9, color: GOLD });
    draw('Total (annual)', M, y - 4, 9, bold, INK);
    const t1 = '$' + b.t1, t2 = '$' + b.t2;
    draw(t1, RIGHT - 130 - rightW(t1, bold, 9), y - 4, 9, bold, INK);
    draw(t2, RIGHT - rightW(t2, bold, 9), y - 4, 9, bold, INK);
    y -= 20;
  }
  function blockLoan(b) {
    subhead(b.sub || 'Loan structure');
    const heads = ['New/existing', 'Loan $', 'I/O or R/C', '% p.a.', 'Years', 'Fixed/Var', 'W/F/M'];
    const colW = [110, 70, 80, 50, 45, 75, 60];
    const xs = []; let cx = M; for (const w of colW) { xs.push(cx); cx += w; }
    need(16);
    heads.forEach((h, i) => draw(h, xs[i], y, 7.5, bold, MUTE));
    y -= 4; page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.5, color: LINE }); y -= 11;
    b.rows.forEach(r => {
      need(12);
      r.forEach((c, i) => { if (i < xs.length) { const ls = wrap(c, font, 8, colW[i] - 4); draw(ls[0], xs[i], y, 8, font, INK); } });
      y -= 12;
    });
    y -= 4;
  }
  function blockChecklist(b) {
    subhead(b.sub || 'Checklist');
    const xs = [M, M + 250, M + 320, M + 390];
    need(14);
    ['Document', 'Attached', 'Forthcoming', 'Comment'].forEach((h, i) => draw(h, xs[i], y, 7.5, bold, MUTE));
    y -= 4; page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.5, color: LINE }); y -= 11;
    b.rows.forEach(r => {
      need(12);
      draw(r.doc, xs[0], y, 8.5, font, INK);
      draw(r.attached, xs[1], y, 8.5, font, INK);
      draw(r.forthcoming, xs[2], y, 8.5, font, INK);
      const cl = wrap(r.comment, font, 8.5, RIGHT - xs[3]); draw(cl[0], xs[3], y, 8.5, font, INK);
      y -= 12;
    });
    y -= 4;
  }
  function blockConfirms(b) {
    subhead(b.sub);
    b.items.forEach(it => {
      const lines = wrap(it.text, font, 8.5, WIDTH - 22);
      need(lines.length * 11 + 4);
      // checkbox glyph
      page.drawRectangle({ x: M, y: y - 1.5, width: 9, height: 9, borderWidth: 1, borderColor: MUTE, color: it.checked ? GOLD : rgb(1, 1, 1) });
      if (it.checked) draw('X', M + 1.6, y - 0.5, 8, bold, INK);
      lines.forEach((ln, i) => { draw(ln, M + 18, y, 8.5, font, INK); if (i < lines.length - 1) y -= 11; });
      y -= 14;
    });
    y -= 2;
  }

  function declarationsText() {
    DECLARATIONS.forEach(p => {
      const lines = wrap(p, font, 8.5, WIDTH);
      need(lines.length * 11 + 6);
      lines.forEach(ln => { draw(ln, M, y, 8.5, font, rgb(0.2, 0.2, 0.2)); y -= 11; });
      y -= 5;
    });
  }

  function signatureBlocks() {
    need(80);
    const colW = (WIDTH - 30) / 2;
    function block(idx, name, x) {
      const top = y;
      page.drawLine({ start: { x, y: top - 22 }, end: { x: x + colW, y: top - 22 }, thickness: 1, color: INK });
      draw('**signature_' + idx + '**', x, top - 18, 7, font, rgb(0.82, 0.82, 0.82));
      draw((name || ('Applicant ' + idx)) + ' \u2014 signed', x, top - 34, 8, font, MUTE);
      page.drawLine({ start: { x, y: top - 52 }, end: { x: x + colW, y: top - 52 }, thickness: 1, color: INK });
      draw('**date_' + idx + '**', x, top - 48, 7, font, rgb(0.82, 0.82, 0.82));
      draw('Date', x, top - 64, 8, font, MUTE);
    }
    block(1, sub.signer1 && sub.signer1.name, M);
    if (sub.signer2 && (sub.signer2.name || sub.signer2.email)) block(2, sub.signer2.name, M + colW + 30);
    y -= 78;
  }

  function blockTable(b) {
    subhead(b.sub);
    const heads = b.head || []; const n = heads.length; if (!n) return;
    const numSet = {}; (b.num || []).forEach(i => numSet[i] = true);
    const weights = heads.map((h, i) => i === 0 ? 2 : 1);
    const tw = weights.reduce((a, c) => a + c, 0);
    const xs = [], cw = []; let cx = M;
    for (let i = 0; i < n; i++) { const w = WIDTH * (weights[i] / tw); cw.push(w); xs.push(cx); cx += w; }
    need(16);
    heads.forEach((h, i) => {
      const tx = numSet[i] ? xs[i] + cw[i] - rightW(h, bold, 7.5) - 4 : xs[i];
      draw(h, tx, y, 7.5, bold, MUTE);
    });
    y -= 4; page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.5, color: LINE }); y -= 11;
    function renderRow(cells, isTotal) {
      const f = isTotal ? bold : font;
      const wrapped = cells.map((c, i) => wrap(c, f, 8, cw[i] - 6));
      const maxL = wrapped.reduce((m, w) => Math.max(m, w.length), 1);
      need(maxL * 11 + 3);
      for (let li = 0; li < maxL; li++) {
        cells.forEach((c, i) => {
          const ln = wrapped[i][li]; if (ln === undefined) return;
          const tx = numSet[i] ? xs[i] + cw[i] - rightW(ln, f, 8) - 4 : xs[i];
          draw(ln, tx, y, 8, f, INK);
        });
        y -= 11;
      }
      y -= 2;
    }
    (b.rows || []).forEach(r => renderRow(r, false));
    if (b.total) { page.drawLine({ start: { x: M, y: y + 4 }, end: { x: RIGHT, y: y + 4 }, thickness: 0.9, color: GOLD }); y -= 2; renderRow(b.total, true); }
    y -= 4;
  }
  function blockPara(b) {
    subhead(b.sub);
    (b.items || []).forEach(p => {
      const lines = wrap(p, font, 8.5, WIDTH);
      need(lines.length * 11 + 5);
      lines.forEach(ln => { draw(ln, M, y, 8.5, font, rgb(0.2, 0.2, 0.2)); y -= 11; });
      y -= 5;
    });
  }

  // ---- render every section ----
  (report.sections || []).forEach(sec => {
    heading(sec.n, sec.title);
    const isDecl = /declaration/i.test(sec.title || '');
    const isSign = /declaration|signature/i.test(sec.title || '');
    if (isDecl) declarationsText();
    (sec.blocks || []).forEach(b => {
      switch (b.type) {
        case 'fields': blockFields(b); break;
        case 'money2': blockMoney2(b); break;
        case 'money1': blockMoney1(b); break;
        case 'income': blockIncome(b); break;
        case 'loan': blockLoan(b); break;
        case 'checklist': blockChecklist(b); break;
        case 'confirms': blockConfirms(b); break;
        case 'table': blockTable(b); break;
        case 'para': blockPara(b); break;
      }
    });
    if (isSign) signatureBlocks();
    y -= 6;
  });

  // If the form had no Declarations/Signatures section in the report, still add signatures.
  if (!(report.sections || []).some(s => /declaration|signature/i.test(s.title || ''))) {
    heading('', 'Signatures');
    signatureBlocks();
  }

  // ---- footer on every page ----
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText('Agile Strategy Ltd \u2014 Paul Newton · FA FSP496026 · FAP FSP1004382',
      { x: M, y: 26, size: 7, font, color: MUTE });
    p.drawText('Page ' + (i + 1) + ' of ' + pages.length,
      { x: RIGHT - 58, y: 26, size: 7, font, color: MUTE });
  });

  return Buffer.from(await pdf.save());
}

module.exports = { buildPdf };
