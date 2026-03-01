module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only', status: 405 } });
  }

  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Provide a search query via ?q=', status: 400 } });
  }

  try {
    const gammaRes = await fetch(
      `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(q)}`
    );
    if (!gammaRes.ok) throw new Error(`GAMMA search failed: ${gammaRes.status}`);
    const data = await gammaRes.json();

const markets = (event.markets || [])
  .filter(m => m.active && !m.closed)
  .sort((a, b) => parseFloat(a.groupItemThreshold || 0) - parseFloat(b.groupItemThreshold || 0))
  .map(m => {
    let outcomes = [];
    let outcomePrices = [];
    try { outcomes = JSON.parse(m.outcomes || '[]'); } catch(e) {}
    try { outcomePrices = JSON.parse(m.outcomePrices || '[]'); } catch(e) {}
    return {
      id: m.id,
      question: m.question,
      groupItemTitle: m.groupItemTitle || null,
      slug: m.slug,
      conditionId: m.conditionId,
      active: m.active,
      closed: m.closed,
      outcomes,
      outcomePrices,
      volume: m.volume || null,
      liquidity: m.liquidity || null,
      startDate: m.startDate || null,
      endDate: m.endDate || null,
    };
  });

    return res.status(200).json({
      query: q,
      resultCount: events.length,
      events,
    });

  } catch (err) {
    console.error('Search endpoint error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
};
