// api/sheet-config.js
//
// Serves this brand's resolved {fileId, gid} pairs, read from a single
// SHEET_CONFIG env var (JSON string) set in the Vercel project. The point:
// index.html loads this via <script src="/api/sheet-config"> instead of
// hardcoding sheet file IDs / gids directly in client-visible source, so
// reverse-engineering one brand's dashboard doesn't hand someone every
// brand's sheet IDs.
//
// Served as a JS assignment (window.SHEET_CFG = {...}) rather than JSON so
// it can be loaded as a plain <script> tag — script tags run in document
// order, so window.SHEET_CFG is guaranteed to exist before any of the
// dashboard's own inline script runs. No async/await needed anywhere else
// in index.html for this.
//
// Keys with a null gid mean "not built yet for this brand" — the client
// should hide/skip that section rather than error.
//
// For debugging, visit /api/sheet-config?format=json to see the raw object
// instead of the JS assignment.

module.exports = (req, res) => {
  let config;
  try {
    config = JSON.parse(process.env.SHEET_CONFIG || '{}');
  } catch (err) {
    res.status(500).json({ error: 'SHEET_CONFIG env var is not valid JSON' });
    return;
  }

  // Cache at the edge/CDN for 5 min — this data changes rarely (only when
  // you update the env var + redeploy), so no need to hit this on every
  // page load from every browser.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (req.query && req.query.format === 'json') {
    res.status(200).json(config);
    return;
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.status(200).send(`window.SHEET_CFG = ${JSON.stringify(config)};`);
};
