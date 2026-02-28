module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only', status: 405 },
    });
  }

  const { slug } = req.query;
  if (!slug) {
    return res.status(400).json({
      error: { code: 'INVALID_INPUT', message: 'Provide a market slug.', status: 400 },
    });
  }

  const marketSlug = slug.trim().toLowerCase();

  try {
    // Step 1: Fetch market metadata from GAMMA
    const gammaRes = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`
    );
    if (!gammaRes.ok) throw new Error(`GAMMA API failed: ${gammaRes.status}`);
    const markets = await gammaRes.json();

    if (!markets || markets.length === 0) {
      return res.status(404).json({
        error: {
          code: 'MARKET_NOT_FOUND',
          message: `No market found with slug '${marketSlug}'`,
          status: 404,
        },
      });
    }

    const market = markets[0];

    // Extract token IDs
    const clobTokenIds = market.clobTokenIds
      ? JSON.parse(market.clobTokenIds)
      : [];
    const conditionId = market.conditionId;
    const primaryTokenId = clobTokenIds[0];
    const secondaryTokenId = clobTokenIds[1];

    if (!primaryTokenId) {
      return res.status(400).json({
        error: {
          code: 'NO_TOKEN_IDS',
          message: 'This market has no CLOB token IDs.',
          status: 400,
        },
      });
    }

    // Step 2: Fetch all data in parallel from CLOB + DATA APIs
    const startTime = Date.now();

    const results = await Promise.allSettled([
      fetch(`https://clob.polymarket.com/book?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://clob.polymarket.com/spread?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://clob.polymarket.com/midpoint?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://clob.polymarket.com/prices-history?market=${primaryTokenId}&interval=1d&fidelity=30`).then(r => r.ok ? r.json() : null),
      fetch(`https://clob.polymarket.com/prices-history?market=${primaryTokenId}&interval=1h&fidelity=24`).then(r => r.ok ? r.json() : null),
      fetch(`https://clob.polymarket.com/trades?market=${primaryTokenId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://data-api.polymarket.com/holders?market=${conditionId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://data-api.polymarket.com/open-interest?market=${conditionId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://data-api.polymarket.com/trades?market=${conditionId}`).then(r => r.ok ? r.json() : null),
    ]);

    const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);

    const get = (i) => results[i].status === 'fulfilled' ? results[i].value : null;
    const err = (i) => results[i].status === 'rejected' ? results[i].reason.message : null;

    const orderbook = get(0);
    const spread = get(1);
    const midpoint = get(2);
    const priceHistory30d = get(3);
    const priceHistory24h = get(4);
    const trades = get(5);
    const holders = get(6);
    const openInterest = get(7);
    const marketTrades = get(8);

    // Collect any errors
    const labels = ['orderbook', 'spread', 'midpoint', 'priceHistory30d', 'priceHistory24h', 'trades', 'holders', 'openInterest', 'marketTrades'];
    const apiErrors = {};
    labels.forEach((label, i) => {
      const e = err(i);
      if (e) apiErrors[label] = e;
    });

    // Step 3: Build response
    const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No'];

    return res.status(200).json({
      polyscore: null,
      polyscoreStatus: 'Phase 0 — raw data only, scoring coming in Phase 1',
      fetchTime: parseFloat(fetchTime),

      market: {
        title: market.question,
        slug: market.slug,
        conditionId: market.conditionId,
        status: market.active ? (market.closed ? 'closed' : 'open') : 'inactive',
        image: market.image,
        description: market.description,
        resolutionSource: market.resolutionSource || null,
        outcomes,
        tags: market.tags ? JSON.parse(market.tags) : [],
        startTime: market.startDate || market.createdAt,
        endTime: market.endDate || null,
        volume: market.volume || null,
        liquidity: market.liquidity || null,
        tokenIds: { yes: primaryTokenId, no: secondaryTokenId || null },
      },

      rawData: {
        orderbook: orderbook ? {
          bids: orderbook.bids ? orderbook.bids.length : 0,
          asks: orderbook.asks ? orderbook.asks.length : 0,
          bestBid: orderbook.bids?.[0] || null,
          bestAsk: orderbook.asks?.[0] || null,
        } : null,
        spread: spread || null,
        midpoint: midpoint || null,
        priceHistory: {
          daily30d: priceHistory30d ? { points: Array.isArray(priceHistory30d.history) ? priceHistory30d.history.length : Array.isArray(priceHistory30d) ? priceHistory30d.length : 0 } : null,
          hourly24h: priceHistory24h ? { points: Array.isArray(priceHistory24h.history) ? priceHistory24h.history.length : Array.isArray(priceHistory24h) ? priceHistory24h.length : 0 } : null,
        },
        trades: trades ? { count: Array.isArray(trades) ? trades.length : 0, latest: Array.isArray(trades) ? trades.slice(0, 3) : null } : null,
        holders: holders || null,
        openInterest: openInterest || null,
        marketTrades: marketTrades ? { count: Array.isArray(marketTrades) ? marketTrades.length : 0 } : null,
      },

      apiErrors: Object.keys(apiErrors).length > 0 ? apiErrors : null,
    });

  } catch (err) {
    console.error('Score endpoint error:', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 },
    });
  }
};
