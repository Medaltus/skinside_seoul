// api/sheet-config-pbj.js
//
// Combined skinside SEOUL • PB & Jay dashboard (added 2026-11-19).
// PB & Jay's dashboard (public/pbj_index.html) is served from skinside's
// deployment, where /api/sheet-config returns SKINSIDE's sheet locations.
// This endpoint serves PB & Jay's own {fileId, gid} pairs instead, read from
// the SHEET_CONFIG_PBJ env var (JSON string) on the same Vercel project.
// Same behavior as api/sheet-config.js: JS assignment by default,
// ?format=json for the raw object (pbj_index.html loads it as JSON).

module.exports = (req, res) => {
  let config;
  try {
    config = JSON.parse(process.env.SHEET_CONFIG_PBJ || '{}');
  } catch (err) {
    res.status(500).json({ error: 'SHEET_CONFIG_PBJ env var is not valid JSON' });
    return;
  }

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (req.query && req.query.format === 'json') {
    res.status(200).json(config);
    return;
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.status(200).send(`window.SHEET_CFG = ${JSON.stringify(config)};`);
};
