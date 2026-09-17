/**
 * api/run-voc-themes.js
 * GET/POST /api/run-voc-themes
 *
 * Adapted from Cosmette's own run-voc-themes.js (2026-09-18) for Skinside
 * Seoul. Reads Skinside Seoul's Amazon reviews (SHEET_AMAZON_REVIEWS),
 * groups them by product category, and asks Claude to identify recurring
 * THEMES per category — what customers keep bringing up, positive or
 * negative. Writes results to SHEET_VOC_THEMES, which the external
 * Inventory page's "VOC Themes — {category}" card reads from (currently
 * shows "Not automated yet" — this is what wires it up to real data).
 *
 * TWO REAL CHANGES FROM COSMETTE'S VERSION, both per Jaclyn directly —
 * everything else (the "resolved theme" logic, the recent-vs-older split,
 * the division of labor between deterministic code and Claude) is kept
 * as-is since none of that is brand-specific:
 *
 * 1. TOP 5 THEMES ONLY — Cosmette's version let Claude return as many
 *    real themes as it found, filtered only by "skip anything only one
 *    review mentions." Jaclyn wants this brand's version capped at the
 *    5 most significant themes per category, not every minor one. This
 *    is enforced TWO ways, not just asked for in the prompt: the prompt
 *    instructs Claude to keep only its top 5 by significance, AND the
 *    code defensively sorts by supporting_review_count (descending,
 *    "new"/"active" themes prioritized over merely-carried-over
 *    "resolved" ones — a resolved theme is worth surfacing, but not at
 *    the expense of a real current top-5 slot) and slices to 5 after
 *    the response comes back, in case Claude's own count discipline
 *    slips on a category with an unusually large or noisy review pool.
 *    Matches this whole file's own philosophy: deterministic guarantees
 *    belong in code, not just in a prompt instruction Claude might not
 *    follow exactly every time.
 *
 * 2. CATEGORY SOURCE — Cosmette's version reads a real "Product Category"
 *    column (Master SKU List column K, a "COS • Cleansers"-style
 *    breadcrumb) confirmed to exist on Cosmette's own sheet. Skinside
 *    Seoul's equivalent sheet has no such column confirmed anywhere —
 *    when the dashboard's own external Inventory Reviews-by-category
 *    page was built (2026-09-17), the same gap was hit there and solved
 *    with a small hardcoded SKU->category map instead (SS_REVIEW_CATEGORY_
 *    BY_SKU in index.html), since the catalog is only 7 products. That
 *    EXACT map is duplicated below rather than re-derived from a column
 *    that doesn't exist — a theme written under a category key the
 *    dashboard doesn't also group reviews under would simply never be
 *    found by the VOC Themes card. If the SKU catalog changes (a new
 *    product added, a re-categorization), this map and the one in
 *    index.html both need updating together, or the two will silently
 *    drift apart. MASTER_SKU_LIST_SHEET_ID and the whole column-K read
 *    path are removed entirely here, not just unused — there's nothing
 *    for this brand to read from it.
 *
 * BUILT ON: Cosmette's run-voc-themes.js, 2026-09-15 per Jaclyn, modeled
 * on run-analysis.js's established pattern (deterministic work in code,
 * Claude's only job is turning real review text into structured output).
 *
 * UNLIKE run-analysis.js (documented there as manually triggered,
 * intentionally not a cron): this runs as a real cron, CRON_SECRET-gated
 * on GET the way Vercel's scheduled-function docs describe, matching
 * this project's other real crons. Still callable manually via POST too,
 * for testing before trusting the schedule — same as Cosmette's version.
 *
 * ASSUMPTIONS BELOW THAT NEED A REAL LOOK, NOT JUST A GUESS:
 *   - sheets.amazonReviews / sheets.vocThemes: need real entries in
 *     config/sheets.js pointing at SHEET_AMAZON_REVIEWS / SHEET_VOC_THEMES
 *     env vars, same as Cosmette's own file assumed for its brand — not
 *     confirmed here either way.
 *   - brand.tabName for skinside-seoul on both the reviews sheet and the
 *     (new) VOC Themes sheet — assumed to be 'skinside-seoul', matching
 *     this brand's config/brands.js entry used elsewhere in this
 *     codebase (write-report-insights.js). Not independently confirmed
 *     against the real sheets.
 *   - RECENT_WINDOW_DAYS = 730 (2 years) — carried over from Cosmette's
 *     own confirmed value (90 days left several categories with zero or
 *     one recent review there). NOT independently re-confirmed for
 *     Skinside Seoul's own, much smaller review volume — worth checking
 *     after the first real run here whether 730 days is enough, too
 *     much, or needs its own brand-specific tuning given a 7-SKU catalog
 *     likely has far fewer total reviews per category than Cosmette's.
 *   - CRON_SECRET: assumed to already exist as a Vercel env var for this
 *     project, matching every other real cron here — not independently
 *     verified.
 */

const { readRows, ensureTab, appendRows } = require('./config/_sheets_client');
const sheets = require('./config/sheets');
const brands = require('./config/brands');

// See the ASSUMPTIONS note above — these are the real env var names this
// needs; sheets.amazonReviews / sheets.vocThemes should point at these
// same env vars in config/sheets.js, so every cron/endpoint that needs
// these sheets shares one source of truth instead of a second copy here.
const AMAZON_REVIEWS_SHEET_ID = sheets.amazonReviews || process.env.SHEET_AMAZON_REVIEWS;
const VOC_THEMES_SHEET_ID = sheets.vocThemes || process.env.SHEET_VOC_THEMES;

const VOC_THEMES_HEADERS = ['date', 'category', 'themes_json', 'review_count', 'uploaded_at'];

// Same map as SS_REVIEW_CATEGORY_BY_SKU in index.html — see the file
// header's point 2 for why this is hardcoded rather than read from a
// sheet column. Keep these two in sync by hand if the catalog changes.
const SS_REVIEW_CATEGORY_BY_SKU = {
  'SSS0001': 'Cleansers',       // Heartleaf Foaming Cleanser
  'SSS0002': 'Serums',          // Spicule Serum
  'SSS0003': 'Serums',          // Vitamin C Serum
  'SSS0004': 'Serums',          // 96% Snail Mucin Essence
  'SSS0005': 'Creams',          // 92% Snail Cream
  'SSS0006': 'Creams',          // Vitamin C Capsule Cream
  'SSS0022': 'Masks',           // Biocellulose Coconut Gel Mask
};

// Hard cap on themes returned per category — see file header point 1.
const MAX_THEMES_PER_CATEGORY = 5;

// How far back counts as "recent enough to reflect current reality" for
// judging whether an older theme is still active. See ASSUMPTIONS above —
// carried over from Cosmette's confirmed value, not yet re-confirmed here.
const RECENT_WINDOW_DAYS = 730;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Cron auth — GET requests (Vercel's own scheduled-function trigger)
  // must carry the shared secret. POST is left open for manual testing
  // from a dashboard button before trusting the schedule — same pattern
  // as this project's other real crons.
  if (req.method === 'GET') {
    const authHeader = req.headers.authorization || '';
    if (!process.env.CRON_SECRET) {
      return res.status(500).json({ error: 'CRON_SECRET not configured' });
    }
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const brandId = (req.body && req.body.brand) || req.query.brand || 'skinside-seoul';
  const brand = brands.find(b => b.id === brandId && b.active);
  if (!brand) return res.status(400).json({ error: `Brand '${brandId}' not found or not active` });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  if (!AMAZON_REVIEWS_SHEET_ID) {
    return res.status(500).json({ error: 'SHEET_AMAZON_REVIEWS not configured (sheets.amazonReviews / env var) — see file header.' });
  }
  if (!VOC_THEMES_SHEET_ID) {
    return res.status(500).json({ error: 'SHEET_VOC_THEMES not configured (sheets.vocThemes / env var) — see file header.' });
  }

  try {
    const t0 = Date.now();
    const results = await runVocThemesForBrand(brand, apiKey);
    console.log(`[run-voc-themes] ${brand.id} — done in ${Date.now() - t0}ms, ${results.length} categories processed`);
    return res.status(200).json({ ok: true, categories: results.map(r => r.category) });
  } catch (err) {
    console.error(`[run-voc-themes] ${brand.id} failed:`, err.message);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message });
  }
};

// ── Deterministic grouping/date logic — same "compute in code, Claude only
// writes prose against real numbers" split as run-analysis.js. ──────────────

// Matches index.html's csBaseSku() exactly (strip trailing "-SF",
// uppercase, trim) — needed so review rows' sku column joins to
// SS_REVIEW_CATEGORY_BY_SKU the same way the dashboard's own lookups do.
function baseSku(s) {
  return (s || '').trim().toUpperCase().replace(/-SF$/i, '');
}

// Groups by the SAME hardcoded category map the dashboard's own
// initExternalReviews() groups reviews by (SS_REVIEW_CATEGORY_BY_SKU) —
// a theme written under any other category key would simply never be
// found by the VOC Themes card, which reads by this exact name.
function groupByCategory(reviews) {
  const byCategory = new Map();
  reviews.forEach(r => {
    const sku = baseSku(r.sku);
    const cat = SS_REVIEW_CATEGORY_BY_SKU[sku] || 'Uncategorized';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(r);
  });
  return byCategory;
}

function splitRecentVsOlder(categoryReviews) {
  const now = Date.now();
  const cutoff = now - RECENT_WINDOW_DAYS * MS_PER_DAY;
  const recent = [], older = [];
  categoryReviews.forEach(r => {
    const t = Date.parse(r.date);
    if (!isNaN(t) && t >= cutoff) recent.push(r);
    else older.push(r);
  });
  return { recent, older };
}

// Pulls this category's theme list from the LAST run only (not every
// historical run — an old theme already marked resolved once shouldn't
// need re-litigating every run forever; if it genuinely recurs, it'll
// show up again in a future run's recent-review evidence and get
// re-flagged as active then).
function getPreviousThemesForCategory(themeHistoryRows, category) {
  const rowsForCat = themeHistoryRows
    .filter(r => (r.category || '') === category)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!rowsForCat.length) return null;
  const last = rowsForCat[rowsForCat.length - 1];
  try {
    return JSON.parse(last.themes_json || '[]');
  } catch (e) {
    console.warn(`[run-voc-themes] ${category} — could not parse previous themes_json, treating as no prior history:`, e.message);
    return null;
  }
}

function trimReviewForPrompt(r) {
  // Only what Claude actually needs — keeps the prompt from ballooning on
  // a category with many reviews, and avoids sending reviewer PII (name)
  // that has no bearing on theme extraction.
  return {
    date: r.date,
    rating: r.star_rating,
    title: (r.review_title || '').slice(0, 200),
    text: (r.review_text || '').slice(0, 600),
  };
}

// Enforces MAX_THEMES_PER_CATEGORY in code, not just via the prompt —
// see file header point 1 for why. Ranks "new"/"active" themes ahead of
// "resolved" ones (a current issue or win is worth a top-5 slot before a
// fixed one is), then by supporting_review_count descending within each
// group, and slices to the cap.
function enforceThemeCap(themes) {
  if (!Array.isArray(themes)) return [];
  const rank = t => (t && t.status === 'resolved') ? 1 : 0;
  const sorted = themes.slice().sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return (Number(b && b.supporting_review_count) || 0) - (Number(a && a.supporting_review_count) || 0);
  });
  return sorted.slice(0, MAX_THEMES_PER_CATEGORY);
}

async function runVocThemesForBrand(brand, apiKey) {
  const [reviewRows, themeHistoryRows] = await Promise.all([
    readRows(AMAZON_REVIEWS_SHEET_ID, brand.tabName).catch(() => []),
    readRows(VOC_THEMES_SHEET_ID, brand.tabName).catch(() => []),
  ]);
  console.log(`[run-voc-themes] ${brand.id} — reviewRows:${reviewRows.length} themeHistoryRows:${themeHistoryRows.length}`);

  const byCategory = groupByCategory(reviewRows);
  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  // Sequential, not Promise.all — matches run-analysis.js's own caution
  // around Claude calls: running every category's call in parallel risks
  // several long generations stacking against Vercel's function-level
  // time budget at once, where sequential at least fails one category at
  // a time instead of risking the whole run.
  for (const [category, categoryReviews] of byCategory.entries()) {
    const { recent, older } = splitRecentVsOlder(categoryReviews);
    const previousThemes = getPreviousThemesForCategory(themeHistoryRows, category);

    if (!recent.length) {
      console.log(`[run-voc-themes] ${brand.id}/${category} — no reviews in the last ${RECENT_WINDOW_DAYS} days, skipping (nothing new to judge resolution against).`);
      continue;
    }

    const rawThemes = await extractThemesForCategory({
      brand, category, recentReviews: recent, olderReviewCount: older.length, previousThemes, apiKey,
    });
    const themes = enforceThemeCap(rawThemes);
    if (rawThemes.length > MAX_THEMES_PER_CATEGORY) {
      console.log(`[run-voc-themes] ${brand.id}/${category} — Claude returned ${rawThemes.length} themes, capped to top ${MAX_THEMES_PER_CATEGORY} in code.`);
    }

    const row = [today, category, JSON.stringify(themes), String(categoryReviews.length), new Date().toISOString()];
    const token = await ensureTab(VOC_THEMES_SHEET_ID, brand.tabName, VOC_THEMES_HEADERS);
    await appendRows(VOC_THEMES_SHEET_ID, brand.tabName, [row], token);
    console.log(`[run-voc-themes] ${brand.id}/${category} — wrote ${themes.length} themes (${recent.length} recent reviews, ${older.length} older).`);
    results.push({ category, themes });
  }

  return results;
}

async function extractThemesForCategory({ brand, category, recentReviews, olderReviewCount, previousThemes, apiKey }) {
  const recentTrimmed = recentReviews.map(trimReviewForPrompt);

  const previousThemesSection = previousThemes && previousThemes.length
    ? `PREVIOUSLY IDENTIFIED THEMES FOR THIS CATEGORY (from the last run):\n${JSON.stringify(previousThemes)}\n\nFor each of these, decide based ONLY on the recent reviews below whether it's still "active" (recent reviews still support it) or "resolved" (recent reviews no longer show this issue, even though it was real before — likely because of a packaging, formula, or pricing change). Do not resolve a theme just because a run happened; only resolve it if the recent evidence genuinely doesn't support it anymore.`
    : `No prior theme history exists for this category yet — this is the first run.`;

  const systemPrompt = `You are analyzing real Amazon customer reviews for ${brand.displayName || brand.id}, product category "${category}". Identify recurring THEMES — specific, concrete things multiple customers bring up, not generic restatements of the star rating. A theme needs real supporting evidence from the reviews you're given; never invent one.

Return ONLY a JSON array of AT MOST ${MAX_THEMES_PER_CATEGORY} themes — the ${MAX_THEMES_PER_CATEGORY} MOST SIGNIFICANT ones, not every theme you can find. If more than ${MAX_THEMES_PER_CATEGORY} real recurring themes exist, keep only the top ${MAX_THEMES_PER_CATEGORY}, ranked by how many reviews support them (supporting_review_count) and by how much it matters to the brand — prioritize a real current issue or a strong differentiator over a minor or single-review mention. Do not pad the list to reach ${MAX_THEMES_PER_CATEGORY}; return fewer than ${MAX_THEMES_PER_CATEGORY} if that's all the real evidence supports. No prose outside the JSON array. Each theme object:
{
  "theme": "short, specific label (e.g. 'Scent is stronger than expected', 'Absorbs quickly without residue')",
  "status": "active" | "resolved" | "new",
  "sentiment": "positive" | "negative" | "mixed",
  "supporting_review_count": <number of the RECENT reviews that support this theme>,
  "example_quote": "<one short real quote, under 25 words, from an actual review below — never paraphrase this into something no review said>",
  "most_recent_review_date": "<the date (YYYY-MM-DD) of whichever supporting review is most recent — copy this exactly from that review's date, never estimate or guess>",
  "note": "<1 sentence: what this means for the brand, e.g. 'worth calling this out more in product copy' — only if genuinely useful, otherwise empty string>"
}

Rules:
- "resolved" only applies to a theme carried over from PREVIOUSLY IDENTIFIED THEMES below that the recent reviews no longer support.
- "new" is for a real theme with no match in the previous list. This only means newly IDENTIFIED by this tracking process — it does NOT mean the underlying reviews are themselves recent. most_recent_review_date is what actually shows how current the evidence is, since "new" alone can be misleading on an early run against reviews that have existed for a while.
- "active" is for a theme (whether carried over or newly spotted) that the recent reviews currently support.
- Do not fabricate a quote or a date — every example_quote and every most_recent_review_date must come directly from one of the reviews you're given.
- Skip anything that only one review mentions unless it's a safety/quality concern worth flagging regardless of volume.
- NEVER create a theme about a damaged box, damaged/crushed packaging in shipping, a leaking or broken item on arrival, or anything else describing shipping/transit damage. This is a fulfillment (FBA) issue, not a product theme, and doesn't belong here even if several reviews mention it. A review can still support an unrelated real product theme even if it also happens to mention shipping damage — just don't let the damage itself become or support a theme.`;

  const userPrompt = `${previousThemesSection}

RECENT REVIEWS (last ${RECENT_WINDOW_DAYS} days, ${recentReviews.length} total — this is the evidence to judge both new and carried-over themes against):
${JSON.stringify(recentTrimmed)}

(${olderReviewCount} additional older reviews exist for this category but are intentionally excluded from judging current themes — only used historically to originally identify carried-over themes.)`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 250000); // same 250s client-side abort as run-analysis.js, see that file's comment for why

  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr.name === 'AbortError') {
      console.error(`[run-voc-themes] ${category} — Claude call aborted after 250s. Returning empty theme list for this category rather than failing the whole run.`);
      return [];
    }
    throw fetchErr;
  }
  clearTimeout(timeoutId);

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    console.error(`[run-voc-themes] ${category} — Claude API error ${claudeRes.status}: ${errText.slice(0, 300)}`);
    return []; // one category's failure shouldn't take down every other category's run
  }

  const data = await claudeRes.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  try {
    const cleaned = text.replace(/^```json\s*|```\s*$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`[run-voc-themes] ${category} — could not parse Claude's response as JSON:`, e.message, '— raw response:', text.slice(0, 500));
    return [];
  }
}
