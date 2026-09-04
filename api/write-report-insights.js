/**
 * api/write-report-insights.js
 * POST /api/write-report-insights
 *
 * Skinside Seoul backend for the internal dashboard's editable report
 * content (Executive Summary, Amazon Key Insight, What's Been Accomplished
 * cards + images, Opportunity cards, and the per-event summaries on the
 * Events pages). Adapted from Évolis's own write-report-insights.js — same
 * file name, same POST contract, same upsert/approval behavior. All of
 * Évolis's original design notes still apply unchanged:
 *   - No staging/live workflow on individual content blocks — Edit, add
 *     content, Save. One "Approved & Ready" button per scope (once on
 *     the Sales Overview tab for the monthly row, once per event tab).
 *   - Multiple months/events can sit at status=Approved simultaneously —
 *     whatever (not-yet-built) view consumes this is responsible for
 *     picking the most recent Approved row.
 *   - UPSERTS, never blind-appends — reads existing rows, finds the
 *     matching key, merges in only the fields provided, writes the full
 *     set back.
 *   - Any content save reverts an already-Approved row back to Draft;
 *     only action:'approve' sets Approved. Deliberate — an edit after
 *     approval shouldn't silently stay live without a fresh review.
 *
 * Reads/writes the shared "Report Insights" spreadsheet — the SAME
 * spreadsheet Évolis, Skinuva, Just Bjorn, and Cosmette already use, just
 * one more tab pair. UNCONFIRMED for this brand — I don't have a verified
 * tab name/gid for skinside-seoul on that shared sheet (unlike the Dazzle
 * Dry / Vivian Valenty Skincare example this was adapted from, which had
 * a live-checked confirmation). Needs the same read-only check before
 * this is trusted: confirm a "skinside-seoul" (or however it's actually
 * named) tab and "skinside-seoul_events" tab exist, with Évolis's
 * original 26-column (monthly) / 9-column (events) header row already in
 * place, no data rows yet.
 *
 * MONTHLY_HEADERS below intentionally starts with Évolis's ORIGINAL 26
 * columns, in their EXACT existing order, UNCHANGED — including
 * website_key_insight/walmart_key_insight/ad_impressions_note, which this
 * brand's dashboard doesn't currently write to either. They stay because
 * the physical sheet already has them in these exact column positions;
 * dropping or reordering them here would desync this file's column
 * mapping from the sheet's real layout. This brand's one addition —
 * What's Been Accomplished (4 cards, images on cards 1-2) — is appended
 * at the end, same rule Évolis's own file documents: a new field ALWAYS
 * goes at the end, never interspersed, or replaceRows() silently shifts
 * every existing row's data into the wrong columns on the next save.
 * NOT added here, unlike the Dazzle Dry / Vivian Valenty Skincare example
 * this was adapted from: category_key_insight and opp5/opp6 — those exist
 * on that brand's dashboard, not on Skinside Seoul's (which still has the
 * original 4 Opportunity cards, opp1-4, already covered by Évolis's
 * original columns). Adding schema fields with no corresponding UI would
 * just be dead columns no save path ever populates.
 *
 * ⚠ ASSUMES config/_sheets_client.js (ensureTab/readRows/replaceRows,
 * same (sheetId, tabName, headers, rows, token) signature already
 * established elsewhere in this codebase) and config/sheets.js already
 * exist in this project, matching Évolis's. If either doesn't exist yet,
 * say so and I'll build a self-contained version that talks to the
 * Google Sheets API directly instead — no shared config needed.
 *
 * config/brands.js needs one new entry (exact tabName match required —
 * confirm the real tab name first, per the note above):
 *   { id: 'skinside-seoul', name: 'Skinside Seoul', tabName: 'skinside-seoul', active: true }
 * I don't have visibility into this brand's config/brands.js itself, so
 * if it already has a different id or tabName reserved, use that instead
 * — the dashboard's REPORT_BRAND_ID constant needs to match exactly or
 * every save 400s.
 *
 * POST body (unchanged from Évolis):
 *   Monthly: { brand, scope:'monthly', year, month, fields:{...}, action:'save'|'approve', actor }
 *   Event:   { brand, scope:'event', eventName, eventYear, fields:{...}, action:'save'|'approve', actor }
 *   fields is optional on action:'approve' (approving doesn't require new content).
 */

const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const sheets = require('./config/sheets');
const brands = require('./config/brands');

const MONTHLY_HEADERS = [
  // ── Évolis's original 26 columns — exact existing order, unchanged ──
  'year', 'month',
  'exec_summary_title', 'exec_summary_left', 'exec_summary_right',
  'amazon_key_insight', 'website_key_insight', 'walmart_key_insight',
  'opp1_title', 'opp1_subtitle', 'opp1_body',
  'opp2_title', 'opp2_subtitle', 'opp2_body',
  'opp3_title', 'opp3_subtitle', 'opp3_body',
  'opp4_title', 'opp4_subtitle', 'opp4_body',
  'status', 'approved_by', 'approved_at', 'last_updated', 'last_updated_by',
  'ad_impressions_note',

  // ── Skinside Seoul's one addition, appended 2026-09-04 — MUST stay at
  // the end. What's Been Accomplished — 4 cards. Cards 1-2 support up to
  // 3/2 image URLs respectively — stored as plain URL strings for now
  // (paste a hosted link); a real upload feature is a planned future
  // replacement for how these URLs get populated, not for how they're
  // stored or displayed. ──
  'accomplished1_title', 'accomplished1_subtitle', 'accomplished1_body',
  'accomplished1_image1', 'accomplished1_image2', 'accomplished1_image3',
  'accomplished2_title', 'accomplished2_subtitle', 'accomplished2_body',
  'accomplished2_image1', 'accomplished2_image2',
  'accomplished3_title', 'accomplished3_subtitle', 'accomplished3_body',
  'accomplished4_title', 'accomplished4_subtitle', 'accomplished4_body',
];

const EVENT_HEADERS = [
  'event_name', 'event_year',
  'summary_title', 'summary_body',
  'status', 'approved_by', 'approved_at', 'last_updated', 'last_updated_by',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand: brandId, scope, year, month, eventName, eventYear, fields, action, actor } = req.body || {};

  const brand = brands.find(b => b.id === brandId && b.active);
  if (!brand) return res.status(400).json({ error: `Brand '${brandId}' not found or not active` });

  if (scope !== 'monthly' && scope !== 'event') {
    return res.status(400).json({ error: "scope must be 'monthly' or 'event'" });
  }
  if (action !== 'save' && action !== 'approve') {
    return res.status(400).json({ error: "action must be 'save' or 'approve'" });
  }

  try {
    if (scope === 'monthly') {
      const yearStr = String(year ?? '').trim();
      const monthStr = String(month ?? '').trim();
      if (!yearStr || !monthStr) return res.status(400).json({ error: 'year and month are required for scope=monthly' });
      // Extra sanity check: month should be a real 1-12 value. Catches
      // anything that survived the trim (e.g. a non-numeric string)
      // before it gets written to the sheet, rather than silently
      // upserting a row keyed on garbage.
      const monthNum = Number(monthStr);
      if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
        return res.status(400).json({ error: `month must be an integer 1-12, got '${month}'` });
      }
      const result = await upsertRow({
        tabName: brand.tabName,
        headers: MONTHLY_HEADERS,
        matchFields: { year: yearStr, month: monthStr },
        fields, action, actor,
      });
      return res.status(200).json({ ok: true, row: result });
    } else {
      const eventNameStr = String(eventName ?? '').trim();
      const eventYearStr = String(eventYear ?? '').trim();
      if (!eventNameStr || !eventYearStr) return res.status(400).json({ error: 'eventName and eventYear are required for scope=event' });
      const result = await upsertRow({
        tabName: `${brand.tabName}_events`,
        headers: EVENT_HEADERS,
        matchFields: { event_name: eventNameStr, event_year: eventYearStr },
        fields, action, actor,
      });
      return res.status(200).json({ ok: true, row: result });
    }
  } catch (err) {
    console.error('[write-report-insights] failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function upsertRow({ tabName, headers, matchFields, fields, action, actor }) {
  const token = await ensureTab(sheets.reportInsights, tabName, headers);
  const existing = await readRows(sheets.reportInsights, tabName);

  const matchKeys = Object.keys(matchFields);
  const idx = existing.findIndex(r => matchKeys.every(k => String(r[k] || '') === matchFields[k]));

  let row;
  if (idx === -1) {
    row = {};
    headers.forEach(h => { row[h] = ''; });
    Object.assign(row, matchFields);
  } else {
    row = { ...existing[idx] }; // copy — don't mutate the object still sitting in `existing`
  }

  if (fields) {
    Object.entries(fields).forEach(([k, v]) => {
      if (headers.includes(k)) row[k] = v == null ? '' : String(v);
    });
  }

  const nowIso = new Date().toISOString();
  if (action === 'approve') {
    row.status = 'Approved';
    row.approved_by = actor || '';
    row.approved_at = nowIso;
  } else {
    // Any content save reverts an already-approved row to Draft — see
    // the ASSUMPTION note in the file header. Approving is a separate,
    // explicit action.
    row.status = row.status === 'Approved' ? 'Draft' : (row.status || 'Draft');
  }
  row.last_updated = nowIso;
  row.last_updated_by = actor || '';

  const updatedRows = idx === -1 ? [...existing, row] : existing.map((r, i) => (i === idx ? row : r));
  const rowArrays = updatedRows.map(r => headers.map(h => r[h] ?? ''));
  await replaceRows(sheets.reportInsights, tabName, headers, rowArrays, token);
  return row;
}
