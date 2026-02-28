module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const checks = {};

  const apis = [
    { name: 'gamma', url: 'https://gamma-api.polymarket.com/markets?limit=1' },
    { name: 'clob', url: 'https://clob.polymarket.com/time' },
    { name: 'data', url: 'https://data-api.polymarket.com/' },
  ];

  await Promise.all(
    apis.map(async ({ name, url }) => {
      try {
        const start = Date.now();
        const r = await fetch(url);
        checks[name] = {
          status: r.ok ? 'ok' : 'degraded',
          responseTime: Date.now() - start,
          httpStatus: r.status,
        };
      } catch (err) {
        checks[name] = { status: 'down', error: err.message };
      }
    })
  );

  const allOk = Object.values(checks).every((c) => c.status === 'ok');

  return res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    phase: 0,
    polymarketApis: checks,
  });
};
