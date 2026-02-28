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

function computeLiquidityMetrics(orderbook, spread, midpoint, marketTrades) {
  const metrics = {};
  const midValue = midpoint?.mid ? parseFloat(midpoint.mid) : null;

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

  let depthAt1 = null, depthAt5 = null, bookImbalance = null;
  if (orderbook && midValue) {
    const bids = orderbook.bids || [];
    const asks = orderbook.asks || [];
    let bidDepth1 = 0, askDepth1 = 0, bidDepth5 = 0, askDepth5 = 0;
    let totalBidDepth = 0, totalAskDepth = 0;
    for (const bid of bids) {
      const price = parseFloat(bid.price), size = parseFloat(bid.size);
      const distPct = ((midValue - price) / midValue) * 100;
      totalBidDepth += price * size;
      if (distPct <= 1) bidDepth1 += price * size;
      if (distPct <= 5) bidDepth5 += price * size;
    }
    for (const ask of asks) {
      const price = parseFloat(ask.price), size = parseFloat(ask.size);
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

  metrics.depthAt1Pct = { value: depthAt1 != null ? parseFloat(depthAt1.toFixed(2)) : null, unit: 'USD', score: scoreBetween(depthAt1, 500, 50000), signal: depthAt1 == null ? 'unavailable' : depthAt1 > 20000 ? 'good' : depthAt1 > 2000 ? 'neutral' : 'bad' };
  metrics.depthAt5Pct = { value: depthAt5 != null ? parseFloat(depthAt5.toFixed(2)) : null, unit: 'USD', score: scoreBetween(depthAt5, 2000, 200000), signal: depthAt5 == null ? 'unavailable' : depthAt5 > 50000 ? 'good' : depthAt5 > 10000 ? 'neutral' : 'bad' };
  metrics.bookImbalance = { value: bookImbalance != null ? parseFloat(bookImbalance.toFixed(3)) : null, unit: 'ratio', score: scoreCloseTo(bookImbalance, 0.5, 0.5), signal: bookImbalance == null ? 'unavailable' : Math.abs(bookImbalance - 0.5) < 0.15 ? 'good' : Math.abs(bookImbalance - 0.5) < 0.3 ? 'neutral' : 'bad' };

  let volume24h = null, volume7d = null, volumeTrend = null;
  if (marketTrades && Array.isArray(marketTrades)) {
    const now = Date.now() / 1000;
    let vol24 = 0, vol7d = 0, volPrior7d = 0;
    for (const trade of marketTrades) {
      const ts = trade.timestamp || 0;
      const value = parseFloat(trade.size || 0) * parseFloat(trade.price || 0);
      if (ts >= now - 86400) vol24 += value;
      if (ts >= now - 86400 * 7) vol7d += value;
      if (ts >= now - 86400 * 14 && ts < now - 86400 * 7) volPrior7d += value;
    }
    volume24h = vol24;
    volume7d = vol7d;
    if (volPrior7d > 0) volumeTrend = ((vol7d - volPrior7d) / volPrior7d) * 100;
  }

  metrics.volume24h = { value: volume24h != null ? parseFloat(volume24h.toFixed(2)) : null, unit: 'USD', score: scoreBetween(volume24h, 1000, 500000), signal: volume24h == null ? 'unavailable' : volume24h > 100000 ? 'good' : volume24h > 10000 ? 'neutral' : 'bad' };
  metrics.volume7d = { value: volume7d != null ? parseFloat(volume7d.toFixed(2)) : null, unit: 'USD', score: scoreBetween(volume7d, 5000, 2000000), signal: volume7d == null ? 'unavailable' : volume7d > 500000 ? 'good' : volume7d > 50000 ? 'neutral' : 'bad' };
  metrics.volumeTrend = { value: volumeTrend != null ? parseFloat(volumeTrend.toFixed(1)) : null, unit: '%', score: volumeTrend != null ? scoreBetween(volumeTrend, -50, 100) : null, signal: volumeTrend == null ? 'unavailable' : volumeTrend > 10 ? 'good' : volumeTrend > -10 ? 'neutral' : 'bad' };

  const scores = Object.values(metrics).map(m => m.score).filter(s => s != null);
  return { score: scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null, confidence: scores.length >= 5 ? 'high' : scores.length >= 3 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 7, metrics };
}

// ─── DISCOVERY PILLAR ────────────────────────────────────────

function computeDiscoveryMetrics(midpoint, priceHistory30d) {
  const metrics = {};
  const midValue = midpoint?.mid ? parseFloat(midpoint.mid) : null;

  let history = [];
  if (priceHistory30d) {
    const raw = Array.isArray(priceHistory30d.history) ? priceHistory30d.history : Array.isArray(priceHistory30d) ? priceHistory30d : [];
    history = [...raw].sort((a, b) => (a.t || 0) - (b.t || 0));
  }

  metrics.currentPrice = { value: midValue, unit: 'probability', score: null, signal: midValue == null ? 'unavailable' : 'neutral' };

  let priceChange24h = null;
  if (history.length >= 2 && midValue != null) {
    const priorPrice = history[history.length - 2]?.p;
    if (priorPrice != null && priorPrice > 0) priceChange24h = ((midValue - priorPrice) / priorPrice) * 100;
  }
  metrics.priceChange24h = { value: priceChange24h != null ? parseFloat(priceChange24h.toFixed(2)) : null, unit: '%', score: null, signal: priceChange24h == null ? 'unavailable' : Math.abs(priceChange24h) > 10 ? 'warn' : 'neutral' };

  const last7 = history.slice(-7);
  let low7d = null, high7d = null;
  if (last7.length > 0) {
    const prices = last7.map(c => c.p).filter(p => p != null);
    if (prices.length > 0) { low7d = Math.min(...prices); high7d = Math.max(...prices); }
  }
  metrics.priceRange7d = { value: low7d != null ? [parseFloat(low7d.toFixed(3)), parseFloat(high7d.toFixed(3))] : null, unit: 'range', score: null, signal: low7d == null ? 'unavailable' : 'neutral' };

  let realizedVol7d = null;
  if (last7.length >= 3) {
    const prices = last7.map(c => c.p).filter(p => p != null);
    const returns = [];
    for (let i = 1; i < prices.length; i++) { if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]); }
    if (returns.length >= 2) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      realizedVol7d = Math.sqrt(variance) * 100;
    }
  }
  metrics.realizedVol7d = { value: realizedVol7d != null ? parseFloat(realizedVol7d.toFixed(2)) : null, unit: '%', score: realizedVol7d != null ? scoreCloseTo(realizedVol7d, 6, 30) : null, signal: realizedVol7d == null ? 'unavailable' : realizedVol7d > 2 && realizedVol7d < 15 ? 'good' : realizedVol7d < 1 ? 'neutral' : 'warn' };

  let autocorrelation = null;
  if (history.length >= 5) {
    const prices = history.map(c => c.p).filter(p => p != null);
    const returns = [];
    for (let i = 1; i < prices.length; i++) { if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]); }
    if (returns.length >= 4) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      let num = 0, den = 0;
      for (let i = 1; i < returns.length; i++) num += (returns[i] - mean) * (returns[i - 1] - mean);
      for (let i = 0; i < returns.length; i++) den += Math.pow(returns[i] - mean, 2);
      if (den > 0) autocorrelation = num / den;
    }
  }
  metrics.autocorrelation = { value: autocorrelation != null ? parseFloat(autocorrelation.toFixed(3)) : null, unit: 'corr', score: autocorrelation != null ? scoreCloseTo(autocorrelation, 0, 1) : null, signal: autocorrelation == null ? 'unavailable' : Math.abs(autocorrelation) < 0.2 ? 'good' : Math.abs(autocorrelation) < 0.5 ? 'neutral' : 'warn' };

  let priceEfficiency = null;
  if (metrics.autocorrelation.score != null && metrics.realizedVol7d.score != null) {
    priceEfficiency = parseFloat((metrics.autocorrelation.score * 0.6 + metrics.realizedVol7d.score * 0.4).toFixed(1));
  }
  metrics.priceEfficiency = { value: priceEfficiency, unit: '/10', score: priceEfficiency != null ? Math.round(priceEfficiency) : null, signal: priceEfficiency == null ? 'unavailable' : priceEfficiency >= 7 ? 'good' : priceEfficiency >= 4 ? 'neutral' : 'bad' };

  const scorable = ['realizedVol7d', 'autocorrelation', 'priceEfficiency'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  return { score: scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null, confidence: scores.length >= 3 ? 'high' : scores.length >= 2 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 6, metrics };
}

// ─── PARTICIPATION PILLAR ────────────────────────────────────

function computeParticipationMetrics(holders) {
  const metrics = {};
  let allPositions = [];

  if (holders && Array.isArray(holders)) {
    for (const side of holders) {
      if (side.holders && Array.isArray(side.holders)) {
        for (const h of side.holders) allPositions.push(parseFloat(h.amount || 0));
      }
    }
  }

  const totalPositions = allPositions.length;
  const sorted = [...allPositions].sort((a, b) => b - a);
  const totalAmount = sorted.reduce((a, b) => a + b, 0);

  metrics.uniqueWallets = { value: totalPositions, unit: 'count (top holders only)', score: scoreBetween(totalPositions, 5, 500), signal: totalPositions === 0 ? 'unavailable' : totalPositions > 200 ? 'good' : totalPositions > 50 ? 'neutral' : 'bad' };

  let top5Pct = null;
  if (totalAmount > 0 && sorted.length >= 5) { top5Pct = (sorted.slice(0, 5).reduce((a, b) => a + b, 0) / totalAmount) * 100; }
  metrics.top5Concentration = { value: top5Pct != null ? parseFloat(top5Pct.toFixed(1)) : null, unit: '%', score: top5Pct != null ? (11 - scoreBetween(top5Pct, 20, 90)) : null, signal: top5Pct == null ? 'unavailable' : top5Pct < 30 ? 'good' : top5Pct < 60 ? 'neutral' : 'bad' };

  let top10Pct = null;
  if (totalAmount > 0 && sorted.length >= 10) { top10Pct = (sorted.slice(0, 10).reduce((a, b) => a + b, 0) / totalAmount) * 100; }
  metrics.top10Concentration = { value: top10Pct != null ? parseFloat(top10Pct.toFixed(1)) : null, unit: '%', score: top10Pct != null ? (11 - scoreBetween(top10Pct, 30, 95)) : null, signal: top10Pct == null ? 'unavailable' : top10Pct < 50 ? 'good' : top10Pct < 75 ? 'neutral' : 'bad' };

  let gini = null;
  if (sorted.length >= 2 && totalAmount > 0) {
    const n = sorted.length;
    const sortedAsc = [...allPositions].sort((a, b) => a - b);
    let sumOfDiffs = 0;
    for (let i = 0; i < n; i++) sumOfDiffs += (2 * (i + 1) - n - 1) * sortedAsc[i];
    gini = Math.max(0, Math.min(1, sumOfDiffs / (n * totalAmount)));
  }
  metrics.giniCoefficient = { value: gini != null ? parseFloat(gini.toFixed(3)) : null, unit: 'index', score: gini != null ? (11 - scoreBetween(gini, 0.2, 0.95)) : null, signal: gini == null ? 'unavailable' : gini < 0.4 ? 'good' : gini < 0.7 ? 'neutral' : 'bad' };

  const whaleCount = sorted.filter(a => a > 10000).length;
  metrics.whaleCount = { value: whaleCount, unit: 'count', score: null, signal: totalPositions === 0 ? 'unavailable' : 'neutral' };

  const retailCount = allPositions.filter(a => a < 1000).length;
  const retailRatio = totalPositions > 0 ? (retailCount / totalPositions) * 100 : null;
  metrics.retailRatio = { value: retailRatio != null ? parseFloat(retailRatio.toFixed(1)) : null, unit: '% (top holders only)', score: scoreBetween(retailRatio, 10, 80), signal: retailRatio == null ? 'unavailable' : retailRatio > 60 ? 'good' : retailRatio > 30 ? 'neutral' : 'bad' };

  let medianPosition = null;
  if (sorted.length > 0) {
    const mid = Math.floor(sorted.length / 2);
    medianPosition = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  metrics.medianPosition = { value: medianPosition != null ? parseFloat(medianPosition.toFixed(2)) : null, unit: 'USD', score: null, signal: medianPosition == null ? 'unavailable' : 'neutral' };

  const scorable = ['uniqueWallets', 'top5Concentration', 'top10Concentration', 'giniCoefficient', 'retailRatio'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  return { score: scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null, confidence: scores.length >= 4 ? 'high' : scores.length >= 2 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 7, metrics };
}

// ─── MATURITY PILLAR ─────────────────────────────────────────

function computeMaturityMetrics(gammaMarket, priceHistory30d, marketTrades) {
  const metrics = {};
  const now = new Date();

  // 1. Market age (days since creation)
  const startTime = gammaMarket.startDate || gammaMarket.createdAt;
  let marketAge = null;
  if (startTime) {
    marketAge = Math.floor((now - new Date(startTime)) / (1000 * 60 * 60 * 24));
  }
  metrics.marketAge = {
    value: marketAge,
    unit: 'days',
    score: scoreBetween(marketAge, 1, 180),
    signal: marketAge == null ? 'unavailable' : marketAge > 60 ? 'good' : marketAge > 14 ? 'neutral' : 'bad',
  };

  // 2. Days to resolution
  const endTime = gammaMarket.endDate;
  let daysToResolution = null;
  if (endTime) {
    daysToResolution = Math.floor((new Date(endTime) - now) / (1000 * 60 * 60 * 24));
    if (daysToResolution < 0) daysToResolution = 0;
  }
  metrics.daysToResolution = {
    value: daysToResolution,
    unit: 'days',
    score: null,
    signal: daysToResolution == null ? 'unavailable' : daysToResolution > 30 ? 'good' : daysToResolution > 7 ? 'neutral' : 'warn',
  };

  // 3. Lifecycle stage
  let lifecycleStage = null;
  if (marketAge != null && daysToResolution != null) {
    const totalLife = marketAge + daysToResolution;
    const pctComplete = totalLife > 0 ? (marketAge / totalLife) * 100 : 0;
    if (pctComplete < 25) lifecycleStage = 'Early';
    else if (pctComplete < 50) lifecycleStage = 'Growth';
    else if (pctComplete < 75) lifecycleStage = 'Mature';
    else if (pctComplete < 90) lifecycleStage = 'Late';
    else lifecycleStage = 'Near Expiry';
  }
  // Growth and Mature stages score highest
  const stageScores = { 'Early': 5, 'Growth': 8, 'Mature': 10, 'Late': 6, 'Near Expiry': 3 };
  metrics.lifecycleStage = {
    value: lifecycleStage,
    unit: 'stage',
    score: lifecycleStage ? stageScores[lifecycleStage] : null,
    signal: lifecycleStage == null ? 'unavailable' : lifecycleStage === 'Mature' || lifecycleStage === 'Growth' ? 'good' : lifecycleStage === 'Near Expiry' ? 'warn' : 'neutral',
  };

  // 4. Price stability — variance of prices over history
  let priceStability = null;
  let history = [];
  if (priceHistory30d) {
    const raw = Array.isArray(priceHistory30d.history) ? priceHistory30d.history : Array.isArray(priceHistory30d) ? priceHistory30d : [];
    history = raw.map(c => c.p).filter(p => p != null);
  }
  if (history.length >= 5) {
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / history.length;
    priceStability = Math.sqrt(variance);
  }
  // Lower variance = more stable = better for maturity
  metrics.priceStability = {
    value: priceStability != null ? parseFloat(priceStability.toFixed(4)) : null,
    unit: 'σ',
    score: priceStability != null ? (11 - scoreBetween(priceStability, 0.01, 0.3)) : null,
    signal: priceStability == null ? 'unavailable' : priceStability < 0.05 ? 'good' : priceStability < 0.15 ? 'neutral' : 'bad',
  };

  // 5. Activity trend — are trades recent or stale?
  let activityTrend = null;
  if (marketTrades && Array.isArray(marketTrades) && marketTrades.length > 0) {
    const nowSec = Date.now() / 1000;
    const recentTrades = marketTrades.filter(t => (t.timestamp || 0) >= nowSec - 86400 * 7).length;
    const olderTrades = marketTrades.filter(t => {
      const ts = t.timestamp || 0;
      return ts >= nowSec - 86400 * 14 && ts < nowSec - 86400 * 7;
    }).length;
    if (olderTrades > 0) {
      activityTrend = recentTrades / olderTrades;
    } else if (recentTrades > 0) {
      activityTrend = 2.0; // Recent activity but no prior = positive signal
    }
  }
  metrics.activityTrend = {
    value: activityTrend != null ? parseFloat(activityTrend.toFixed(2)) : null,
    unit: 'ratio',
    score: activityTrend != null ? scoreBetween(activityTrend, 0.2, 3) : null,
    signal: activityTrend == null ? 'unavailable' : activityTrend > 1.2 ? 'good' : activityTrend > 0.5 ? 'neutral' : 'bad',
  };

  // 6. Total volume as maturity signal
  const totalVolume = parseFloat(gammaMarket.volume || 0);
  metrics.totalVolume = {
    value: totalVolume > 0 ? parseFloat(totalVolume.toFixed(2)) : null,
    unit: 'USD',
    score: scoreBetween(totalVolume, 10000, 5000000),
    signal: totalVolume > 1000000 ? 'good' : totalVolume > 100000 ? 'neutral' : 'bad',
  };

  const scorable = ['marketAge', 'lifecycleStage', 'priceStability', 'activityTrend', 'totalVolume'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  return { score: scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null, confidence: scores.length >= 4 ? 'high' : scores.length >= 3 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 6, metrics };
}

// ─── MAIN HANDLER ────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only', status: 405 } });
  }

  const { slug } = req.query;
  if (!slug) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Provide a market slug.', status: 400 } });
  }

  const marketSlug = slug.trim().toLowerCase();

  try {
    const gammaRes = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`);
    if (!gammaRes.ok) throw new Error(`GAMMA API failed: ${gammaRes.status}`);
    const markets = await gammaRes.json();

    if (!markets || markets.length === 0) {
      return res.status(404).json({ error: { code: 'MARKET_NOT_FOUND', message: `No market found with slug '${marketSlug}'`, status: 404 } });
    }

    const market = markets[0];
    const clobTokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
    const conditionId = market.conditionId;
    const primaryTokenId = clobTokenIds[0];
    const secondaryTokenId = clobTokenIds[1];

    if (!primaryTokenId) {
      return res.status(400).json({ error: { code: 'NO_TOKEN_IDS', message: 'No CLOB token IDs.', status: 400 } });
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

    // Compute all 4 pillars
    const liquidity = computeLiquidityMetrics(orderbook, spread, midpoint, marketTrades);
    const discovery = computeDiscoveryMetrics(midpoint, priceHistory30d);
    const participation = computeParticipationMetrics(holders);
    const maturity = computeMaturityMetrics(market, priceHistory30d, marketTrades);

    const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No'];

    return res.status(200).json({
      polyscore: null,
      polyscoreStatus: 'Phase 4 — 4 of 5 pillars live, Resolution pillar coming next',
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
        discovery: discovery.score,
        participation: participation.score,
        maturity: maturity.score,
        resolution: null,
      },

      pillars: {
        liquidity,
        discovery,
        participation,
        maturity,
      },

      rawData: {
        orderbook: orderbook ? { bids: orderbook.bids ? orderbook.bids.length : 0, asks: orderbook.asks ? orderbook.asks.length : 0, bestBid: orderbook.bids?.[0] || null, bestAsk: orderbook.asks?.[0] || null } : null,
        spread: spread || null,
        midpoint: midpoint || null,
        priceHistory: {
          daily30d: priceHistory30d ? { points: Array.isArray(priceHistory30d.history) ? priceHistory30d.history.length : Array.isArray(priceHistory30d) ? priceHistory30d.length : 0 } : null,
          hourly24h: priceHistory24h ? { points: Array.isArray(priceHistory24h.history) ? priceHistory24h.history.length : Array.isArray(priceHistory24h) ? priceHistory24h.length : 0 } : null,
        },
        holders: holders ? { sides: Array.isArray(holders) ? holders.length : 0, totalHolders: Array.isArray(holders) ? holders.reduce((sum, s) => sum + (s.holders ? s.holders.length : 0), 0) : 0 } : null,
        openInterest: openInterest || null,
        marketTrades: marketTrades ? { count: Array.isArray(marketTrades) ? marketTrades.length : 0 } : null,
      },
    });

  } catch (err) {
    console.error('Score endpoint error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
};
