/**
 * api/config/brands.js
 * Brand registry for Skinside Seoul's own repo.
 *
 * Unlike évolis's repo (which shares one Amazon seller account across ~15
 * Medaltus brands and needs the full registry for crons that loop over
 * every active brand in one run), Skinside Seoul's repo only ever processes
 * Skinside Seoul itself — the "Run Analysis" / "Run Listing Audit" / "Run
 * PPC Analysis" buttons on Skinside Seoul's own dashboard always call
 * these endpoints with { brand: "skinside-seoul" }. A single-entry array
 * is intentional here, not a placeholder to fill in later. This mirrors
 * Skinuva's own repo-level brands.js exactly.
 *
 * skuPrefix:       first 3 chars of all SKUs for this brand ("SSS").
 *                   Confirm this doesn't collide with any other active
 *                   brand's prefix in the shared évolis-repo brands.js
 *                   before shipping anything that matches on SKU prefix
 *                   alone — not verified in this session.
 * tabName:         slug used as the Google Sheet tab name — this is what
 *                   every readRows/ensureTab/appendRows call in
 *                   run-analysis.js, run-listing-audit.js, and
 *                   run-ppc-strategy-analysis.js uses to select which
 *                   brand's tab to read/write on each shared,
 *                   multi-brand sheet (Business Report, Insights,
 *                   Listing Audit, etc.) — so this MUST exactly match
 *                   the "skinside-seoul" tab name already confirmed
 *                   against the Dashboard Mapping sheet's row for this
 *                   brand (fileId 1SiYu8e2-Pfi14Aiuf6SAFytWVXb4_dtdNFT6wvLFPok
 *                   family and related sheets).
 * active:          set false to pause without deleting config.
 * amazonBrandName: EXACT string as registered in Amazon Brand Registry,
 *                   ALL CAPS. PLACEHOLDER ONLY — not sourced from any
 *                   confirmed reference this session (unlike Skinuva's
 *                   entry, which was at least copied from évolis's
 *                   already-verified file). Confirm the real value
 *                   against Amazon Brand Registry before this is used
 *                   anywhere that filters/matches by brand name (e.g.
 *                   SP-API brand-scoped calls).
 */
module.exports = [
  {
    id:              'skinside-seoul',
    tabName:         'skinside-seoul',
    skuPrefix:       'SSS',
    displayName:     'Skinside Seoul',
    amazonBrandName: 'SKINSIDE SEOUL', // TODO: confirm against Amazon Brand Registry
    active:          true,
  },
];
