// ─── SCORING HELPERS ─────────────────────────────────────────

function scoreBetween(value, min, max) {
  if (value == null) return null;
  if (value <= min) return 1;
  if (value >= max) return 10;
  return Math.round(1 + ((value - min) / (max - min)) * 9);
}

function scoreCloseTo(value, target, tolerance) {
  if (value == null) return null;
  const distance = Math.abs(value - target);
  if (distance >= tolerance) return 1;
  return Math.round(10 - (distance / tolerance) * 9);
}

// ─── LIQUIDITY PILLAR ────────────────────────────────────────

function computeLiquidityMetrics(orderbook, spread, midpoint, trades) {
  const metrics = {};
  const midValue = midpoint?.mid ? parseFloat(midpoint.mid) : null;

  // 1. Bid-ask spread
  const spreadValue = spread?.spread ? parseFloat(spread.spread) : null;
  let spreadPct = null;
  if (spreadValue != null && midValue != null && midValue > 0) {
    spreadPct = (spreadValue / midValue) * 100;
  }
  metrics.bidAskSpread = {
    value: spreadPct != null ? parseFloat(spreadPct.toFixed(2)) : null,
    unit: '%',
    score: spreadPct != null ? (11 - scoreBetween(spreadPct, 1, 25)) : null,
    signal: spreadPct == null ? 'unavailable' : spreadPct < 3 ? 'good' : spreadPct < 10 ? 'neutral' : 'bad',
  };

  // 2 & 3. Depth at 1% and 5%
  let depthAt1 = null;
  let depthAt5 = null;
  let bookImbalance = null;

  if (orderbook && midValue) {
    const bids = orderbook.bids || [];
    const asks = orderbook.asks || [];
    let bidDepth1 = 0, askDepth1 = 0, bidDepth5 = 0, askDepth5 = 0;
    let totalBidDepth = 0, totalAskDepth = 0;

    for (const bid of bids) {
      const price = parseFloat(bid.price);
      const size = parseFloat(bid.size);
      const distPct = ((midValue - price) / midValue) * 100;
      totalBidDepth += price * size;
      if (distPct <= 1) bidDepth1 += price * size;
      if (distPct <= 5) bidDepth5 += price * size;
    }
    for (const ask of asks) {
      const price = parseFloat(ask.price);
      const size = parseFloat(ask.size);
      const distPct = ((price - midValue) / midValue) * 100;
      totalAskDepth += price * size;
      if (distPct <= 1) askDepth1 += price * size;
      if (distPct <= 5) askDepth5 += price * size;
    }

    depthAt1 = bidDepth1 + askDepth1;
    depthAt5 = bidDepth5 + askDepth5;
    const totalDepth = totalBidDepth + totalAskDepth;
    bookImbalance = totalDepth > 0 ? totalBidDepth / totalDepth : null;
  }

  metrics.depthAt1Pct = {
    value: depthAt1 != null ? parseFloat(depthAt1.toFixed(2)) : null,
    unit: 'USD',
    score: scoreBetween(depthAt1, 500, 50000),
    signal: depthAt1 == null ? 'unavailable' : depthAt1 > 20000 ? 'good' : depthAt1 > 2000 ? 'neutral' : 'bad',
  };

  metrics.depthAt5Pct = {
    value: depthAt5 != null ? parseFloat(depthAt5.toFixed(2)) : null,
    unit: 'USD',
    score: scoreBetween(depthAt5, 2000, 200000),
    signal: depthAt5 == null ? 'unavailable' : depthAt5 > 50000 ? 'good' : depthAt5 > 10000 ? 'neutral' : 'bad',
  };

  // 4. Book imbalance
  metrics.bookImbalance = {
    value: bookImbalance != null ? parseFloat(bookImbalance.toFixed(3)) : null,
    unit: 'ratio',
    score: scoreCloseTo(bookImbalance, 0.5, 0.5),
    signal: bookImbalance == null ? 'unavailable' : Math.abs(bookImbalance - 0.5) < 0.15 ? 'good' : Math.abs(bookImbalance - 0.5) < 0.3 ? 'neutral' : 'bad',
  };

  // 5, 6, 7. Volume from trades
  let volume24h = null;
  let volume7d = null;
  let volumeTrend = null;

  if (trades && Array.isArray(trades)) {
    const now = Date.now() / 1000;
    const oneDayAgo = now - 86400;
    const sevenDaysAgo = now - 86400 * 7;
    const fourteenDaysAgo = now - 86400 * 14;

    let vol24 = 0, vol7d = 0, volPrior7d = 0;

    for (const trade of trades) {
      const ts = trade.timestamp || trade.t || 0;
      const size = parseFloat(trade.size || trade.amount || trade.makerAmountFilled || 0);
      const price = parseFloat(trade.price || trade.p || 0);
      const value = size * price;

      if (ts >= oneDayAgo) vol24 += value;
      if (ts >= sevenDaysAgo) vol7d += value;
      if (ts >= fourteenDaysAgo && ts < sevenDaysAgo) volPrior7d += value;
    }

    volume24h = vol24;
    volume7d = vol7d;
    if (volPrior7d > 0) {
      volumeTrend = ((vol7d - volPrior7d) / volPrior7d) * 100;
    }
  }

  metrics.volume24h = {
    value: volume24h != null ? parseFloat(volume24h.toFixed(2)) : null,
    unit: 'USD',
    score: scoreBetween(volume24h, 1000, 500000),
    signal: volume24h == null ? 'unavailable' : volume24h > 100000 ? 'good' : volume24h > 10000 ? 'neutral' : 'bad',
  };

  metrics.volume7d = {
    value: volume7d != null ? parseFloat(volume7d.toFixed(2)) : null,
    unit: 'USD',
    score: scoreBetween(volume7d, 5000, 2000000),
    signal: volume7d == null ? 'unavailable' : volume7d > 500000 ? 'good' : volume7d > 50000 ? 'neutral' : 'bad',
  };

  metrics.volumeTrend = {
    value: volumeTrend != null ? parseFloat(volumeTrend.toFixed(1)) : null,
    unit: '%',
    score: volumeTrend != null ? scoreBetween(volumeTrend, -50, 100) : null,
    signal: volumeTrend == null ? 'unavailable' : volumeTrend > 10 ? 'good' : volumeTrend > -10 ? 'neutral' : 'bad',
  };

  // Pillar score
  const scores = Object.values(metrics).map(m => m.score).filter(s => s != null);
  const pillarScore = scores.length > 0
    ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1))
    : null;

  return {
    score: pillarScore,
    confidence: scores.length >= 5 ? 'high' : scores.length >= 3 ? 'medium' : 'low',
    metricsComputed: scores.length,
    metricsTotal: 7,
    metrics,
  };
}

// ─── MAIN HANDLER ────────────────────────────────────────────

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
    const gammaRes = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`
    );
    if (!gammaRes.ok) throw new Error(`GAMMA API failed: ${gammaRes.status}`);
    const markets = await gammaRes.json();

    if (!markets || markets.length === 0) {
      return res.status(404).json({
        error: { code: 'MARKET_NOT_FOUND', message: `No market found with slug '${marketSlug}'`, status: 404 },
      });
    }

    const market = markets[0];
    const clobTokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
    const conditionId = market.conditionId;
    const primaryTokenId = clobTokenIds[0];
    const secondaryTokenId = clobTokenIds[1];

    if (!primaryTokenId) {
      return res.status(400).json({
        error: { code: 'NO_TOKEN_IDS', message: 'No CLOB token IDs.', status: 400 },
      });
    }

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

    const orderbook = get(0);
    const spread = get(1);
    const midpoint = get(2);
    const priceHistory30d = get(3);
    const priceHistory24h = get(4);
    const trades = get(5);
    const holders = get(6);
    const openInterest = get(7);
    const marketTrades = get(8);

    // Compute Liquidity pillar
    const liquidity = computeLiquidityMetrics(orderbook, spread, midpoint, trades);

    const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No'];

    return res.status(200).json({
      polyscore: null,
      polyscoreStatus: 'Phase 1 — Liquidity pillar live, 4 more pillars coming',
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

      scores: {
        overall: null,
        liquidity: liquidity.score,
        participation: null,
        discovery: null,
        resolution: null,
        maturity: null,
      },

      pillars: {
        liquidity,
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
        holders: holders ? { count: Array.isArray(holders) ? holders.length : 0 } : null,
        openInterest: openInterest || null,
        marketTrades: marketTrades ? { count: Array.isArray(marketTrades) ? marketTrades.length : 0 } : null,
      },
    });

  } catch (err) {
    console.error('Score endpoint error:', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 },
    });
  }
};
