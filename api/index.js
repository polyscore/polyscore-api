module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  return res.status(200).json({
    name: 'PolyScore API',
    version: '0.1.0',
    phase: 0,
    description: 'Analytics and scoring engine for Polymarket prediction markets',
    endpoints: {
      score: {
        path: '/v1/score/{market_slug}',
        method: 'GET',
        description: 'Get PolyScore and all metrics for a market',
      },
      health: {
        path: '/v1/health',
        method: 'GET',
        description: 'API and upstream service health check',
      },
    },
    status: 'Phase 0 — data pipeline live, scoring coming in Phase 1',
  });
};
