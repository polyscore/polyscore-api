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

// ─── DOME API HELPERS ───────────────────────────────────────

async function fetchDomeTrades(conditionId, daysBack, apiKey, maxPages) {
  const nowSec = Math.floor(Date.now() / 1000);
  const startTime = nowSec - (86400 * daysBack);
  const allTrades = [];
  let paginationKey = null;
  let pages = 0;

  while (pages < maxPages) {
    let url = `https://api.domeapi.io/v1/polymarket/orders?condition_id=${conditionId}&start_time=${startTime}&end_time=${nowSec}&limit=1000`;
    if (paginationKey) url += `&pagination_key=${encodeURIComponent(paginationKey)}`;

    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (!res.ok) break;

    const data = await res.json();
    const orders = data.orders || [];
    allTrades.push(...orders);

    if (!data.pagination?.has_more || !data.pagination?.pagination_key) break;
    paginationKey = data.pagination.pagination_key;
    pages++;
  }

  return allTrades;
}

async function fetchDomeCandles(conditionId, daysBack, interval, apiKey) {
  const nowSec = Math.floor(Date.now() / 1000);
  const startTime = nowSec - (86400 * daysBack);

  const res = await fetch(
    `https://api.domeapi.io/v1/polymarket/candlesticks/${conditionId}?start_time=${startTime}&end_time=${nowSec}&interval=${interval}`,
    { headers: { 'x-api-key': apiKey } }
  );
  if (!res.ok) return null;

  const data = await res.json();
  if (data.candlesticks && data.candlesticks.length > 0) {
    return data.candlesticks[0][0] || [];
  }
  return [];
}

// ─── LIQUIDITY PILLAR ────────────────────────────────────────

function computeLiquidityMetrics(orderbook, spread, midpoint, domeCandles14d, domeTrades) {
  const metrics = {};
  const midValue = midpoint?.mid ? parseFloat(midpoint.mid) : null;
  const fmt = (v, d) => v != null ? parseFloat(v.toFixed(d)) : null;

  // ── 1. Bid-Ask Spread (%) ─────────────────────────────────
  // Source: CLOB /spread + /midpoint
  const spreadValue = spread?.spread ? parseFloat(spread.spread) : null;
  let spreadPct = null;
  if (spreadValue != null && midValue != null && midValue > 0) {
    spreadPct = (spreadValue / midValue) * 100;
  }
  metrics.bidAskSpread = {
    value: fmt(spreadPct, 2),
    unit: '%',
    score: spreadPct != null ? (11 - scoreBetween(spreadPct, 1, 25)) : null,
    signal: spreadPct == null ? 'unavailable' : spreadPct < 3 ? 'good' : spreadPct < 10 ? 'neutral' : 'bad',
    context: spreadPct == null ? null : spreadPct < 2 ? 'Tight spread' : spreadPct < 5 ? 'Moderate' : 'Wide spread',
  };

  // ── 2. Depth at 2% ───────────────────────────────────────
  // Source: CLOB /book + /midpoint
  let depthAt2 = null, bookImbalance = null;
  if (orderbook && midValue) {
    const bids = orderbook.bids || [], asks = orderbook.asks || [];
    let bidD2 = 0, askD2 = 0;
    for (const bid of bids) {
      const p = parseFloat(bid.price), s = parseFloat(bid.size);
      const d = ((midValue - p) / midValue) * 100;
      if (d <= 2) bidD2 += p * s;
    }
    for (const ask of asks) {
      const p = parseFloat(ask.price), s = parseFloat(ask.size);
      const d = ((p - midValue) / midValue) * 100;
      if (d <= 2) askD2 += p * s;
    }
    depthAt2 = bidD2 + askD2;
    bookImbalance = (bidD2 + askD2) > 0 ? bidD2 / (bidD2 + askD2) : null;
  }
  metrics.depthAt2Pct = {
    value: fmt(depthAt2, 2),
    unit: 'USD',
    score: scoreBetween(depthAt2, 1000, 100000),
    signal: depthAt2 == null ? 'unavailable' : depthAt2 > 50000 ? 'good' : depthAt2 > 5000 ? 'neutral' : 'bad',
    context: depthAt2 == null ? null : depthAt2 > 50000 ? 'Strong depth' : depthAt2 > 5000 ? 'Moderate depth' : 'Thin orderbook',
  };

  // ── 3. Book Imbalance (within 2% of midpoint) ────────────
  // Source: CLOB /book
  metrics.bookImbalance = {
    value: fmt(bookImbalance, 3),
    unit: 'ratio',
    score: scoreCloseTo(bookImbalance, 0.5, 0.5),
    signal: bookImbalance == null ? 'unavailable' : Math.abs(bookImbalance - 0.5) < 0.15 ? 'good' : Math.abs(bookImbalance - 0.5) < 0.3 ? 'neutral' : 'bad',
    context: bookImbalance == null ? null
      : Math.abs(bookImbalance - 0.5) < 0.15 ? 'Balanced book'
      : bookImbalance < 0.35 ? 'No buyers near price — hard to exit'
      : bookImbalance > 0.65 ? 'No sellers near price — hard to enter'
      : 'Slightly imbalanced',
  };

  // ── 4. Spread as % of Edge ───────────────────────────────
  // Source: CLOB /spread + /midpoint
  let spreadEdgePct = null;
  if (spreadValue != null && midValue != null && midValue > 0 && midValue < 1) {
    const edge = Math.min(midValue, 1 - midValue);
    if (edge > 0) spreadEdgePct = (spreadValue / edge) * 100;
  }
  metrics.spreadEdgePct = {
    value: fmt(spreadEdgePct, 1),
    unit: '%',
    score: spreadEdgePct != null ? (11 - scoreBetween(spreadEdgePct, 5, 80)) : null,
    signal: spreadEdgePct == null ? 'unavailable' : spreadEdgePct < 10 ? 'good' : spreadEdgePct < 30 ? 'neutral' : 'bad',
    context: spreadEdgePct == null ? null
      : spreadEdgePct < 10 ? 'Low entry cost'
      : spreadEdgePct < 30 ? 'Moderate — spread eats into profits'
      : 'Spread consumes ' + fmt(spreadEdgePct, 0) + '% of your potential profit',
  };

  // ── 5. Volume 24h ────────────────────────────────────────
  // Source: Dome /candlesticks (1d interval, 14 days)
  // Dome candles: volume is in raw shares, price.mean_dollars is avg price
  // Dollar volume = volume * mean_dollars for each candle
  let volume24h = null;
  if (domeCandles14d && Array.isArray(domeCandles14d) && domeCandles14d.length > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const oneDayAgo = nowSec - 86400;
    let vol = 0;
    for (const candle of domeCandles14d) {
      const ts = candle.end_period_ts || 0;
      if (ts >= oneDayAgo) {
        const meanPrice = parseFloat(candle.price?.mean_dollars || 0);
        const shares = parseFloat(candle.volume || 0);
        vol += (shares / 1000000) * meanPrice; // shares are raw (×1M), price is decimal
      }
    }
    volume24h = vol;
  }
  metrics.volume24h = {
    value: fmt(volume24h, 2),
    unit: 'USD',
    score: scoreBetween(volume24h, 1000, 500000),
    signal: volume24h == null ? 'unavailable' : volume24h > 100000 ? 'good' : volume24h > 10000 ? 'neutral' : 'bad',
    context: volume24h == null ? null
      : volume24h > 100000 ? 'Active market'
      : volume24h > 10000 ? 'Moderate activity'
      : volume24h > 0 ? 'Low activity'
      : 'No trades in 24 hours',
  };

  // ── 6. Volume Trend (7d vs prior 7d) ─────────────────────
  // Source: Dome /candlesticks (1d interval, 14 days)
  let volumeTrend = null;
  if (domeCandles14d && Array.isArray(domeCandles14d) && domeCandles14d.length > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = nowSec - 86400 * 7;
    const fourteenDaysAgo = nowSec - 86400 * 14;
    let vol7d = 0, volPrior7d = 0;
    for (const candle of domeCandles14d) {
      const ts = candle.end_period_ts || 0;
      const meanPrice = parseFloat(candle.price?.mean_dollars || 0);
      const shares = parseFloat(candle.volume || 0);
      const dollarVol = (shares / 1000000) * meanPrice;
      if (ts >= sevenDaysAgo) vol7d += dollarVol;
      else if (ts >= fourteenDaysAgo) volPrior7d += dollarVol;
    }
    if (volPrior7d > 0) volumeTrend = ((vol7d - volPrior7d) / volPrior7d) * 100;
    else if (vol7d > 0) volumeTrend = 100;
  }
  metrics.volumeTrend = {
    value: fmt(volumeTrend, 1),
    unit: '%',
    score: volumeTrend != null ? scoreBetween(volumeTrend, -50, 100) : null,
    signal: volumeTrend == null ? 'unavailable' : volumeTrend > 10 ? 'good' : volumeTrend > -10 ? 'neutral' : 'bad',
    context: volumeTrend == null ? null
      : volumeTrend > 20 ? 'Growing interest'
      : volumeTrend > -10 ? 'Stable activity'
      : 'Declining — market losing attention',
  };

  // ── 7. Kyle's Lambda ─────────────────────────────────────
  // Source: Dome /orders (7 days, paginated)
  // Dome trades: price is decimal (0.92), shares_normalized is shares (30 = 30 shares)
  // Trade value in dollars = shares_normalized * price
  let kyleLambda = null;
  if (domeTrades && domeTrades.length >= 10) {
    const sorted = [...domeTrades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let totalLambda = 0, count = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prevPrice = parseFloat(sorted[i-1].price || 0);
      const currPrice = parseFloat(sorted[i].price || 0);
      const tradeValue = parseFloat(sorted[i].shares_normalized || 0) * currPrice;
      if (tradeValue > 0.01 && prevPrice > 0) {
        totalLambda += Math.abs(currPrice - prevPrice) / tradeValue;
        count++;
      }
    }
    if (count > 0) kyleLambda = totalLambda / count;
  }
  metrics.kyleLambda = {
    value: fmt(kyleLambda, 6),
    unit: 'λ',
    score: kyleLambda != null ? (11 - scoreBetween(kyleLambda, 0.0001, 0.01)) : null,
    signal: kyleLambda == null ? 'unavailable' : kyleLambda < 0.001 ? 'good' : kyleLambda < 0.005 ? 'neutral' : 'bad',
    context: kyleLambda == null ? null
      : kyleLambda < 0.001 ? 'Stable — trades absorbed without moving price'
      : kyleLambda < 0.005 ? 'Moderate price impact'
      : 'Fragile — even small trades move the price',
  };

  // ── 8. Time Since Last Trade ──────────────────────────────
  // Source: Dome /orders (most recent trade timestamp)
  let timeSinceLastTrade = null;
  if (domeTrades && domeTrades.length > 0) {
    let maxTs = 0;
    for (const trade of domeTrades) {
      const ts = trade.timestamp || 0;
      if (ts > maxTs) maxTs = ts;
    }
    if (maxTs > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      timeSinceLastTrade = (nowSec - maxTs) / 3600;
    }
  }
  metrics.timeSinceLastTrade = {
    value: fmt(timeSinceLastTrade, 1),
    unit: 'hours',
    score: timeSinceLastTrade != null ? (11 - scoreBetween(timeSinceLastTrade, 1, 168)) : null,
    signal: timeSinceLastTrade == null ? 'unavailable' : timeSinceLastTrade < 6 ? 'good' : timeSinceLastTrade < 48 ? 'neutral' : 'bad',
    context: timeSinceLastTrade == null ? null
      : timeSinceLastTrade < 1 ? 'Traded minutes ago'
      : timeSinceLastTrade < 6 ? 'Recent activity'
      : timeSinceLastTrade < 24 ? 'Last trade ' + fmt(timeSinceLastTrade, 0) + ' hours ago'
      : timeSinceLastTrade < 168 ? 'Last trade ' + fmt(timeSinceLastTrade / 24, 1) + ' days ago'
      : 'No trades in over a week',
  };

  // ── PILLAR SCORE ──────────────────────────────────────────
  const scoredMetrics = ['bidAskSpread', 'depthAt2Pct', 'bookImbalance', 'spreadEdgePct', 'volume24h', 'volumeTrend', 'kyleLambda', 'timeSinceLastTrade'];
  const scores = scoredMetrics.map(k => metrics[k]?.score).filter(s => s != null);
  const pillarScore = scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null;

  // ── WARNINGS ──────────────────────────────────────────────
  const warnings = [];

  const isStale = timeSinceLastTrade != null && timeSinceLastTrade > 48;
  const isThin = depthAt2 != null && depthAt2 < 5000;
  const isWideSpread = spreadPct != null && spreadPct > 10;
  const isDeclining = volumeTrend != null && volumeTrend < -40;
  const isFragile = kyleLambda != null && kyleLambda > 0.005;
  const isNoBuyers = bookImbalance != null && bookImbalance < 0.2;
  const isNoSellers = bookImbalance != null && bookImbalance > 0.8;
  const isExpensiveEdge = spreadEdgePct != null && spreadEdgePct > 40;
  const isDead = volume24h != null && volume24h === 0;

  // Combined warnings (most severe first)
  if (isStale && isThin && isDeclining) {
    warnings.push({ type: 'danger', text: 'Ghost market — last trade ' + fmt(timeSinceLastTrade / 24, 1) + ' days ago, only $' + Math.round(depthAt2).toLocaleString() + ' in the book, and activity down ' + fmt(Math.abs(volumeTrend), 0) + '%. This market exists on paper only.' });
  }
  else if (isDeclining && (isStale || isDead)) {
    warnings.push({ type: 'danger', text: 'Dying market — volume down ' + fmt(Math.abs(volumeTrend), 0) + '% and ' + (isDead ? 'no trades today' : 'last trade ' + fmt(timeSinceLastTrade / 24, 1) + ' days ago') + '. You probably can\'t exit at a fair price.' });
  }
  else if (isNoBuyers && isDeclining) {
    warnings.push({ type: 'danger', text: 'Trapped — no buyers near the price and activity declining. If you enter, you may not be able to get out.' });
  }
  else if (isStale && isWideSpread) {
    warnings.push({ type: 'danger', text: 'Stale and expensive — last trade ' + fmt(timeSinceLastTrade / 24, 1) + ' days ago with a ' + fmt(spreadPct, 1) + '% spread. The price you see is probably not what you\'ll get.' });
  }
  else if (!isWideSpread && isThin) {
    warnings.push({ type: 'warning', text: 'Price mirage — spread looks tight but only $' + Math.round(depthAt2).toLocaleString() + ' behind it. One order will blow through the book.' });
  }
  else if (isFragile && isThin) {
    warnings.push({ type: 'warning', text: 'Fragile and thin — small trades are moving the price and there\'s little depth. This price is noise, not signal.' });
  }

  // Single-metric warnings (only if no combined warning fired)
  if (warnings.length === 0) {
    if (isExpensiveEdge) {
      const edgeStr = midValue != null ? 'Market at ' + Math.round(midValue * 100) + '¢' : 'Near-certain market';
      warnings.push({ type: 'warning', text: edgeStr + ' — the spread consumes ' + fmt(spreadEdgePct, 0) + '% of your potential profit. The math may not work.' });
    }
    else if (isWideSpread) {
      warnings.push({ type: 'warning', text: 'Wide spread — you\'ll pay ' + fmt(spreadPct, 1) + '% just to enter this trade.' });
    }
    else if (isNoSellers) {
      warnings.push({ type: 'warning', text: 'No sellers near the price — buying may push the price up significantly.' });
    }
    else if (isNoBuyers) {
      warnings.push({ type: 'warning', text: 'No buyers near the price — you may struggle to exit your position.' });
    }
    else if (isDead) {
      warnings.push({ type: 'warning', text: 'No trades in the last 24 hours — this price may be stale and unreliable.' });
    }
    else if (isStale) {
      warnings.push({ type: 'warning', text: 'Last trade was ' + fmt(timeSinceLastTrade / 24, 1) + ' days ago — the current price may not reflect reality.' });
    }
    else if (isDeclining) {
      warnings.push({ type: 'warning', text: 'Activity dropped ' + fmt(Math.abs(volumeTrend), 0) + '% this week — this market is losing attention.' });
    }
    else if (isThin) {
      warnings.push({ type: 'warning', text: 'Thin orderbook — only $' + Math.round(depthAt2).toLocaleString() + ' within 2% of the price.' });
    }
    else if (isFragile) {
      warnings.push({ type: 'warning', text: 'Fragile market — even small trades are moving the price significantly.' });
    }
  }

  // Positive signal
  if (warnings.length === 0 && pillarScore != null && pillarScore >= 7) {
    warnings.push({ type: 'info', text: 'Healthy liquidity — tight spread, good depth, active trading. Low-cost entry with reliable exit.' });
  }

  const warning = warnings.length > 0 ? warnings[0] : null;

  return {
    score: pillarScore,
    status: pillarScore >= 7 ? 'pass' : pillarScore >= 4 ? 'caution' : pillarScore != null ? 'fail' : 'unavailable',
    confidence: scores.length >= 6 ? 'high' : scores.length >= 4 ? 'medium' : 'low',
    metricsComputed: scores.length,
    metricsTotal: 8,
    warning,
    warnings,
    metrics,
  };
}

// ─── DISCOVERY PILLAR ────────────────────────────────────────

function computeDiscoveryMetrics(midpoint, priceHistory30d, priceHistory24h) {
  const metrics = {};
  const fmt = (v, d) => v != null ? parseFloat(v.toFixed(d)) : null;
  const midValue = midpoint?.mid ? parseFloat(midpoint.mid) : null;
  let history = [];
  if (priceHistory30d) { const raw = Array.isArray(priceHistory30d.history) ? priceHistory30d.history : Array.isArray(priceHistory30d) ? priceHistory30d : []; history = [...raw].sort((a, b) => (a.t || 0) - (b.t || 0)); }

  // 1. Current price
  metrics.currentPrice = { value: midValue, unit: 'probability', score: null, signal: midValue == null ? 'unavailable' : 'neutral', context: midValue != null ? `${Math.round(midValue * 100)}¢ YES` : null };

  // 2. Price change 24h
  let priceChange24h = null;
  if (history.length >= 2 && midValue != null) { const prior = history[history.length - 2]?.p; if (prior != null && prior > 0) priceChange24h = ((midValue - prior) / prior) * 100; }
  metrics.priceChange24h = { value: fmt(priceChange24h, 2), unit: '%', score: null, signal: priceChange24h == null ? 'unavailable' : Math.abs(priceChange24h) > 10 ? 'warn' : 'neutral', context: priceChange24h == null ? null : Math.abs(priceChange24h) < 1 ? 'Flat' : priceChange24h > 0 ? 'Up' : 'Down' };

  // 3. Price range 7d
  const last7 = history.slice(-7);
  let low7d = null, high7d = null;
  if (last7.length > 0) { const prices = last7.map(c => c.p).filter(p => p != null); if (prices.length > 0) { low7d = Math.min(...prices); high7d = Math.max(...prices); } }
  metrics.priceRange7d = { value: low7d != null ? [fmt(low7d, 3), fmt(high7d, 3)] : null, unit: 'range', score: null, signal: low7d == null ? 'unavailable' : 'neutral', context: low7d != null ? `${fmt(low7d * 100, 1)}¢ – ${fmt(high7d * 100, 1)}¢` : null };

  // 4. Volatility 24h — NEW
  let vol24h = null;
  let hourly = [];
  if (priceHistory24h) { const raw = Array.isArray(priceHistory24h.history) ? priceHistory24h.history : Array.isArray(priceHistory24h) ? priceHistory24h : []; hourly = [...raw].sort((a, b) => (a.t || 0) - (b.t || 0)); }
  if (hourly.length >= 3) {
    const prices = hourly.map(c => c.p).filter(p => p != null);
    const returns = [];
    for (let i = 1; i < prices.length; i++) { if (prices[i-1] > 0) returns.push((prices[i] - prices[i-1]) / prices[i-1]); }
    if (returns.length >= 2) { const mean = returns.reduce((a,b) => a+b, 0) / returns.length; const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length; vol24h = Math.sqrt(variance) * 100; }
  }
  metrics.volatility24h = { value: fmt(vol24h, 2), unit: '%', score: vol24h != null ? scoreCloseTo(vol24h, 4, 30) : null, signal: vol24h == null ? 'unavailable' : vol24h > 2 && vol24h < 10 ? 'good' : vol24h < 1 ? 'neutral' : 'warn', context: vol24h == null ? null : vol24h < 2 ? 'Stable' : vol24h < 10 ? 'Normal range' : 'Volatile' };

  // 5. Realized vol 7d
  let realizedVol7d = null;
  if (last7.length >= 3) { const prices = last7.map(c => c.p).filter(p => p != null); const returns = []; for (let i = 1; i < prices.length; i++) { if (prices[i-1] > 0) returns.push((prices[i] - prices[i-1]) / prices[i-1]); } if (returns.length >= 2) { const mean = returns.reduce((a,b) => a+b, 0) / returns.length; const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length; realizedVol7d = Math.sqrt(variance) * 100; } }
  metrics.realizedVol7d = { value: fmt(realizedVol7d, 2), unit: '%', score: realizedVol7d != null ? scoreCloseTo(realizedVol7d, 6, 30) : null, signal: realizedVol7d == null ? 'unavailable' : realizedVol7d > 2 && realizedVol7d < 15 ? 'good' : realizedVol7d < 1 ? 'neutral' : 'warn', context: realizedVol7d == null ? null : realizedVol7d < 2 ? 'Very stable' : realizedVol7d < 10 ? 'Normal range' : 'High volatility' };

  // 6. Price Momentum 7d — NEW
  let momentum7d = null;
  if (last7.length >= 2 && midValue != null) { const firstPrice = last7[0]?.p; if (firstPrice != null) momentum7d = (midValue - firstPrice) * 100; }
  metrics.priceMomentum = { value: fmt(momentum7d, 1), unit: '¢', score: null, signal: momentum7d == null ? 'unavailable' : 'neutral', context: momentum7d == null ? null : Math.abs(momentum7d) < 1 ? 'Flat' : momentum7d > 0 ? `+${fmt(momentum7d, 1)}¢ uptrend` : `${fmt(momentum7d, 1)}¢ downtrend` };

  // 7. Information Ratio — NEW
  let infoRatio = null;
  if (history.length >= 5) {
    const prices = history.map(c => c.p).filter(p => p != null);
    const returns = [];
    for (let i = 1; i < prices.length; i++) { if (prices[i-1] > 0) returns.push((prices[i] - prices[i-1]) / prices[i-1]); }
    if (returns.length >= 3) {
      const mean = returns.reduce((a,b) => a+b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length);
      if (std > 0) infoRatio = Math.abs(mean) / std;
    }
  }
  metrics.informationRatio = { value: fmt(infoRatio, 3), unit: 'ratio', score: infoRatio != null ? scoreBetween(infoRatio, 0.05, 1.5) : null, signal: infoRatio == null ? 'unavailable' : infoRatio > 0.5 ? 'good' : infoRatio > 0.1 ? 'neutral' : 'bad', context: infoRatio == null ? null : infoRatio > 0.5 ? 'Good signal-to-noise' : infoRatio > 0.1 ? 'Moderate signal' : 'Noisy' };

  // 8. Autocorrelation
  let autocorrelation = null;
  if (history.length >= 5) { const prices = history.map(c => c.p).filter(p => p != null); const returns = []; for (let i = 1; i < prices.length; i++) { if (prices[i-1] > 0) returns.push((prices[i] - prices[i-1]) / prices[i-1]); } if (returns.length >= 4) { const mean = returns.reduce((a,b) => a+b, 0) / returns.length; let num = 0, den = 0; for (let i = 1; i < returns.length; i++) num += (returns[i] - mean) * (returns[i-1] - mean); for (let i = 0; i < returns.length; i++) den += Math.pow(returns[i] - mean, 2); if (den > 0) autocorrelation = num / den; } }
  metrics.autocorrelation = { value: fmt(autocorrelation, 3), unit: 'corr', score: autocorrelation != null ? scoreCloseTo(autocorrelation, 0, 1) : null, signal: autocorrelation == null ? 'unavailable' : Math.abs(autocorrelation) < 0.2 ? 'good' : Math.abs(autocorrelation) < 0.5 ? 'neutral' : 'warn', context: autocorrelation == null ? null : Math.abs(autocorrelation) < 0.2 ? 'Low predictability' : 'Trending pattern detected' };

  // 9. Price Efficiency (composite)
  let priceEfficiency = null;
  if (metrics.autocorrelation.score != null && metrics.realizedVol7d.score != null) priceEfficiency = parseFloat((metrics.autocorrelation.score * 0.6 + metrics.realizedVol7d.score * 0.4).toFixed(1));
  metrics.priceEfficiency = { value: priceEfficiency, unit: '/10', score: priceEfficiency != null ? Math.round(priceEfficiency) : null, signal: priceEfficiency == null ? 'unavailable' : priceEfficiency >= 7 ? 'good' : priceEfficiency >= 4 ? 'neutral' : 'bad', context: priceEfficiency == null ? null : priceEfficiency >= 7 ? 'Efficient price discovery' : 'Potential inefficiency' };

  // Pillar score
  const scorable = ['volatility24h', 'realizedVol7d', 'informationRatio', 'autocorrelation', 'priceEfficiency'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  const pillarScore = scores.length > 0 ? parseFloat((scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1)) : null;

  // Warning
  let warning = null;
  if (autocorrelation != null && Math.abs(autocorrelation) > 0.4) warning = { type: 'warning', text: 'High autocorrelation. Price may be trending rather than reflecting new information.' };
  else if (pillarScore != null && pillarScore >= 7) warning = { type: 'info', text: 'Efficient price discovery. Price changes appear driven by genuine information.' };

  return { score: pillarScore, status: pillarScore >= 7 ? 'pass' : pillarScore >= 4 ? 'caution' : pillarScore != null ? 'fail' : 'unavailable', confidence: scores.length >= 4 ? 'high' : scores.length >= 2 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 9, warning, metrics };
}

// ─── PARTICIPATION PILLAR ────────────────────────────────────

function computeParticipationMetrics(holders, allTrades) {
  const metrics = {};
  const fmt = (v, d) => v != null ? parseFloat(v.toFixed(d)) : null;

  let allPositions = [];
  if (holders && Array.isArray(holders)) {
    for (const side of holders) {
      if (side.holders && Array.isArray(side.holders)) {
        for (const h of side.holders) allPositions.push(parseFloat(h.amount || 0));
      }
    }
  }

  const uniqueWallets = new Set();
  const tradeSizes = [];
  if (allTrades && allTrades.length > 0) {
    for (const trade of allTrades) {
      if (trade.proxyWallet) uniqueWallets.add(trade.proxyWallet);
      const size = parseFloat(trade.size || 0) * parseFloat(trade.price || 0);
      if (size > 0) tradeSizes.push(size);
    }
  }

  // 1. Unique wallets
  const walletCount = uniqueWallets.size;
  metrics.uniqueWallets = { value: walletCount, unit: 'wallets', score: scoreBetween(walletCount, 10, 1000), signal: walletCount === 0 ? 'unavailable' : walletCount > 200 ? 'good' : walletCount > 50 ? 'neutral' : 'bad', context: walletCount === 0 ? null : walletCount > 200 ? 'Broad participation' : walletCount > 50 ? 'Moderate' : 'Low participation' };

  // 2. Top 5 Concentration
  const sorted = [...allPositions].sort((a, b) => b - a);
  const totalAmount = sorted.reduce((a, b) => a + b, 0);
  let top5Pct = null;
  if (totalAmount > 0 && sorted.length >= 5) top5Pct = (sorted.slice(0, 5).reduce((a,b) => a+b, 0) / totalAmount) * 100;
  metrics.top5Concentration = { value: fmt(top5Pct, 1), unit: '%', score: top5Pct != null ? (11 - scoreBetween(top5Pct, 20, 90)) : null, signal: top5Pct == null ? 'unavailable' : top5Pct < 30 ? 'good' : top5Pct < 60 ? 'neutral' : 'bad', context: top5Pct == null ? null : top5Pct < 30 ? 'Well distributed' : top5Pct > 60 ? 'Highly concentrated' : 'Moderate concentration' };

  // 3. Top 10 Concentration
  let top10Pct = null;
  if (totalAmount > 0 && sorted.length >= 10) top10Pct = (sorted.slice(0, 10).reduce((a,b) => a+b, 0) / totalAmount) * 100;
  metrics.top10Concentration = { value: fmt(top10Pct, 1), unit: '%', score: top10Pct != null ? (11 - scoreBetween(top10Pct, 30, 95)) : null, signal: top10Pct == null ? 'unavailable' : top10Pct < 50 ? 'good' : top10Pct < 75 ? 'neutral' : 'bad', context: top10Pct == null ? null : top10Pct < 50 ? 'Diverse holders' : top10Pct > 75 ? 'Top-heavy' : 'Moderate' };

  // 4. Gini Coefficient
  let gini = null;
  if (sorted.length >= 2 && totalAmount > 0) { const n = sorted.length; const asc = [...allPositions].sort((a,b) => a-b); let s = 0; for (let i = 0; i < n; i++) s += (2*(i+1) - n - 1) * asc[i]; gini = Math.max(0, Math.min(1, s / (n * totalAmount))); }
  metrics.giniCoefficient = { value: fmt(gini, 3), unit: 'index', score: gini != null ? (11 - scoreBetween(gini, 0.2, 0.95)) : null, signal: gini == null ? 'unavailable' : gini < 0.4 ? 'good' : gini < 0.7 ? 'neutral' : 'bad', context: gini == null ? null : gini < 0.4 ? 'Relatively equal' : gini > 0.7 ? 'Unequal distribution' : 'Moderate inequality' };

  // 5. Herfindahl-Hirschman Index (HHI) — NEW
  let hhi = null;
  if (sorted.length >= 2 && totalAmount > 0) {
    hhi = 0;
    for (const pos of sorted) { const share = (pos / totalAmount) * 100; hhi += share * share; }
  }
  metrics.herfindahlIndex = { value: fmt(hhi, 0), unit: 'HHI', score: hhi != null ? (11 - scoreBetween(hhi, 500, 5000)) : null, signal: hhi == null ? 'unavailable' : hhi < 1500 ? 'good' : hhi < 2500 ? 'neutral' : 'bad', context: hhi == null ? null : hhi < 1500 ? 'Competitive' : hhi > 2500 ? 'Highly concentrated' : 'Moderate concentration' };

  // 6. Largest Position — NEW
  const largestPos = sorted.length > 0 ? sorted[0] : null;
  metrics.largestPosition = { value: fmt(largestPos, 2), unit: 'USD', score: null, signal: largestPos == null ? 'unavailable' : 'neutral', context: largestPos != null ? `$${Math.round(largestPos).toLocaleString()} largest holder` : null };

  // 7. Small Trade Share (was retailRatio)
  const retailCount = tradeSizes.filter(s => s < 100).length;
  const retailRatio = tradeSizes.length > 0 ? (retailCount / tradeSizes.length) * 100 : null;
  metrics.smallTradeShare = { value: fmt(retailRatio, 1), unit: '%', score: scoreBetween(retailRatio, 5, 70), signal: retailRatio == null ? 'unavailable' : retailRatio > 50 ? 'good' : retailRatio > 20 ? 'neutral' : 'bad', context: retailRatio == null ? null : retailRatio > 50 ? 'Retail-dominated' : retailRatio > 20 ? 'Mixed participation' : 'Whale-dominated' };

  // 8. Large Trade Count (was whaleCount)
  const whaleCount = tradeSizes.filter(s => s > 10000).length;
  metrics.largeTradeCount = { value: whaleCount, unit: 'trades > $10K', score: null, signal: tradeSizes.length === 0 ? 'unavailable' : 'neutral', context: null };

  // 9. Median Trade Size
  let medianTrade = null;
  if (tradeSizes.length > 0) { const st = [...tradeSizes].sort((a, b) => a - b); const mid = Math.floor(st.length / 2); medianTrade = st.length % 2 !== 0 ? st[mid] : (st[mid-1] + st[mid]) / 2; }
  metrics.medianTradeSize = { value: fmt(medianTrade, 2), unit: 'USD', score: null, signal: medianTrade == null ? 'unavailable' : 'neutral', context: medianTrade != null ? `Typical trade: $${fmt(medianTrade, 2)}` : null };

  // Pillar score
  const scorable = ['uniqueWallets', 'top5Concentration', 'top10Concentration', 'giniCoefficient', 'herfindahlIndex', 'smallTradeShare'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  const pillarScore = scores.length > 0 ? parseFloat((scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1)) : null;

  // Warning
  let warning = null;
  if (top5Pct != null && top5Pct > 60) warning = { type: 'danger', text: `High concentration risk. Top 5 wallets control ${fmt(top5Pct, 0)}% of open interest. Price may not reflect broad sentiment.` };
  else if (walletCount > 0 && walletCount < 30) warning = { type: 'warning', text: `Low participation. Only ${walletCount} unique wallets detected.` };
  else if (pillarScore != null && pillarScore >= 7) warning = { type: 'info', text: `Broad participation with ${walletCount} wallets and ${fmt(retailRatio, 0)}% small trades.` };

  return { score: pillarScore, status: pillarScore >= 7 ? 'pass' : pillarScore >= 4 ? 'caution' : pillarScore != null ? 'fail' : 'unavailable', confidence: scores.length >= 4 ? 'high' : scores.length >= 2 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 9, warning, metrics };
}

// ─── MATURITY PILLAR ─────────────────────────────────────────

function computeMaturityMetrics(gammaMarket, priceHistory30d, allTrades, orderbook, midpoint) {
  const metrics = {};
  const fmt = (v, d) => v != null ? parseFloat(v.toFixed(d)) : null;
  const now = new Date();
  const midValue = midpoint?.mid ? parseFloat(midpoint.mid) : null;

  // 1. Market Age
  const startTime = gammaMarket.startDate || gammaMarket.createdAt;
  let marketAge = null;
  if (startTime) marketAge = Math.floor((now - new Date(startTime)) / (1000 * 60 * 60 * 24));
  metrics.marketAge = { value: marketAge, unit: 'days', score: scoreBetween(marketAge, 1, 180), signal: marketAge == null ? 'unavailable' : marketAge > 60 ? 'good' : marketAge > 14 ? 'neutral' : 'bad', context: marketAge == null ? null : marketAge > 60 ? 'Established' : marketAge > 14 ? 'Maturing' : 'Very new' };

  // 2. Days to Resolution
  const endTime = gammaMarket.endDate;
  let daysToResolution = null;
  if (endTime) { daysToResolution = Math.floor((new Date(endTime) - now) / (1000 * 60 * 60 * 24)); if (daysToResolution < 0) daysToResolution = 0; }
  metrics.daysToResolution = { value: daysToResolution, unit: 'days', score: null, signal: daysToResolution == null ? 'unavailable' : daysToResolution > 30 ? 'good' : daysToResolution > 7 ? 'neutral' : 'warn', context: daysToResolution == null ? null : daysToResolution > 60 ? 'Plenty of time' : daysToResolution > 14 ? 'Adequate time' : 'Approaching resolution' };

  // 3. Lifecycle Stage
  let lifecycleStage = null;
  if (marketAge != null && daysToResolution != null) { const total = marketAge + daysToResolution; const pct = total > 0 ? (marketAge / total) * 100 : 0; if (pct < 25) lifecycleStage = 'Early'; else if (pct < 50) lifecycleStage = 'Growth'; else if (pct < 75) lifecycleStage = 'Mature'; else if (pct < 90) lifecycleStage = 'Late'; else lifecycleStage = 'Near Expiry'; }
  const stageScores = { 'Early': 5, 'Growth': 8, 'Mature': 10, 'Late': 6, 'Near Expiry': 3 };
  metrics.lifecycleStage = { value: lifecycleStage, unit: 'stage', score: lifecycleStage ? stageScores[lifecycleStage] : null, signal: lifecycleStage == null ? 'unavailable' : lifecycleStage === 'Mature' || lifecycleStage === 'Growth' ? 'good' : lifecycleStage === 'Near Expiry' ? 'warn' : 'neutral', context: lifecycleStage == null ? null : lifecycleStage === 'Growth' || lifecycleStage === 'Mature' ? 'Optimal stage' : lifecycleStage };

  // 4. Price Stability
  let priceStability = null;
  let historyPrices = [];
  if (priceHistory30d) { const raw = Array.isArray(priceHistory30d.history) ? priceHistory30d.history : Array.isArray(priceHistory30d) ? priceHistory30d : []; historyPrices = raw.map(c => c.p).filter(p => p != null); }
  if (historyPrices.length >= 5) { const mean = historyPrices.reduce((a,b) => a+b, 0) / historyPrices.length; const variance = historyPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / historyPrices.length; priceStability = Math.sqrt(variance); }
  metrics.priceStability = { value: fmt(priceStability, 4), unit: 'σ', score: priceStability != null ? (11 - scoreBetween(priceStability, 0.01, 0.3)) : null, signal: priceStability == null ? 'unavailable' : priceStability < 0.05 ? 'good' : priceStability < 0.15 ? 'neutral' : 'bad', context: priceStability == null ? null : priceStability < 0.05 ? 'Stable pricing' : priceStability < 0.15 ? 'Moderate variability' : 'Volatile pricing' };

  // 5. Activity Trend
  let activityTrend = null;
  if (allTrades && allTrades.length > 0) {
    const nowSec = Date.now() / 1000;
    const recent = allTrades.filter(t => (t.timestamp||0) >= nowSec - 86400*7).length;
    const older = allTrades.filter(t => { const ts = t.timestamp||0; return ts >= nowSec - 86400*14 && ts < nowSec - 86400*7; }).length;
    if (older > 0) activityTrend = recent / older;
    else if (recent > 0) activityTrend = 2.0;
  }
  metrics.activityTrend = { value: fmt(activityTrend, 2), unit: 'ratio', score: activityTrend != null ? scoreBetween(activityTrend, 0.2, 3) : null, signal: activityTrend == null ? 'unavailable' : activityTrend > 1.2 ? 'good' : activityTrend > 0.5 ? 'neutral' : 'bad', context: activityTrend == null ? null : activityTrend > 1.5 ? 'Growing' : activityTrend > 0.8 ? 'Stable' : 'Declining' };

  // 6. Total Volume
  const totalVolume = parseFloat(gammaMarket.volume || 0);
  metrics.totalVolume = { value: totalVolume > 0 ? fmt(totalVolume, 2) : null, unit: 'USD', score: scoreBetween(totalVolume, 10000, 5000000), signal: totalVolume > 1000000 ? 'good' : totalVolume > 100000 ? 'neutral' : 'bad', context: totalVolume > 1000000 ? 'High lifetime volume' : totalVolume > 100000 ? 'Moderate volume' : 'Low volume' };

  // 7. Exit Liquidity — NEW (composite of bid depth + lifecycle stage)
  let exitLiquidity = null;
  let exitLabel = null;
  if (orderbook && midValue && lifecycleStage) {
    const bids = orderbook.bids || [];
    let bidDepth5 = 0;
    for (const bid of bids) {
      const p = parseFloat(bid.price), s = parseFloat(bid.size);
      const d = ((midValue - p) / midValue) * 100;
      if (d <= 5) bidDepth5 += p * s;
    }
    const depthScore = scoreBetween(bidDepth5, 1000, 100000);
    const stageMultiplier = { 'Early': 0.7, 'Growth': 1.0, 'Mature': 1.0, 'Late': 0.6, 'Near Expiry': 0.3 };
    exitLiquidity = parseFloat((depthScore * (stageMultiplier[lifecycleStage] || 0.5)).toFixed(1));
    exitLabel = exitLiquidity >= 7 ? 'Good' : exitLiquidity >= 4 ? 'Moderate' : 'Poor';
  }
  metrics.exitLiquidity = { value: exitLabel, unit: 'assessment', score: exitLiquidity != null ? Math.round(exitLiquidity) : null, signal: exitLiquidity == null ? 'unavailable' : exitLiquidity >= 7 ? 'good' : exitLiquidity >= 4 ? 'neutral' : 'bad', context: daysToResolution != null ? `${daysToResolution} days runway` : null };

  // Pillar score
  const scorable = ['marketAge', 'lifecycleStage', 'priceStability', 'activityTrend', 'totalVolume', 'exitLiquidity'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  const pillarScore = scores.length > 0 ? parseFloat((scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1)) : null;

  // Warning
  let warning = null;
  if (lifecycleStage === 'Near Expiry') warning = { type: 'danger', text: `Market approaching expiry. ${daysToResolution} days remaining. Exit liquidity may deteriorate rapidly.` };
  else if (activityTrend != null && activityTrend < 0.5) warning = { type: 'warning', text: 'Declining activity. Trading volume has dropped significantly.' };
  else if (exitLabel === 'Poor') warning = { type: 'warning', text: 'Poor exit liquidity. You may have difficulty selling your position at a fair price.' };
  else if (pillarScore != null && pillarScore >= 7) warning = { type: 'info', text: `Good timing. Market in ${lifecycleStage} phase with ${activityTrend > 1.2 ? 'growing' : 'stable'} activity. ${daysToResolution} days until resolution.` };

  return { score: pillarScore, status: pillarScore >= 7 ? 'pass' : pillarScore >= 4 ? 'caution' : pillarScore != null ? 'fail' : 'unavailable', confidence: scores.length >= 4 ? 'high' : scores.length >= 3 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 7, warning, metrics };
}

// ─── RESOLUTION PILLAR ───────────────────────────────────────

function computeResolutionMetrics(gammaMarket, openInterest, holders) {
  const metrics = {};
  const fmt = (v, d) => v != null ? parseFloat(v.toFixed(d)) : null;
  const desc = gammaMarket.description || '';

  // 1. Resolution Source
  const resSource = gammaMarket.resolutionSource || null;
  const hasResSource = resSource != null && resSource.length > 0;
  let sourceQuality = 'none';
  if (hasResSource) {
    const lower = resSource.toLowerCase();
    if (lower.includes('ap news') || lower.includes('reuters') || lower.includes('.gov') || lower.includes('official')) sourceQuality = 'authoritative';
    else if (lower.includes('http') || lower.includes('www')) sourceQuality = 'semi-authoritative';
    else sourceQuality = 'subjective';
  }
  metrics.resolutionSource = { value: hasResSource ? resSource : 'Not specified', unit: 'source', score: hasResSource ? (sourceQuality === 'authoritative' ? 10 : sourceQuality === 'semi-authoritative' ? 7 : 5) : 2, signal: !hasResSource ? 'bad' : sourceQuality === 'authoritative' ? 'good' : sourceQuality === 'semi-authoritative' ? 'neutral' : 'warn', context: sourceQuality === 'none' ? 'No source specified' : sourceQuality.charAt(0).toUpperCase() + sourceQuality.slice(1) };

  // 2. Description Length
  const descLength = desc.length;
  metrics.descriptionLength = { value: descLength, unit: 'chars', score: scoreBetween(descLength, 50, 1000), signal: descLength > 500 ? 'good' : descLength > 200 ? 'neutral' : 'bad', context: descLength > 500 ? 'Thorough description' : 'Brief description' };

  // 3. Contract Detail Score (keyword-based, Claude upgrade Phase 2)
  const resolutionKeywords = ['resolve', 'resolution', 'will resolve to', 'yes if', 'no if', 'otherwise', 'source', 'oracle', 'official', 'deadline', 'by', 'before', 'after', 'criteria', 'qualify', 'does not qualify', 'consensus', 'reporting', 'announced', 'defined as', 'means', 'specifically', 'edge case', 'exception', 'excluding', 'including', 'AM ET', 'PM ET', 'UTC', 'EST'];
  const lowerDesc = desc.toLowerCase();
  let keywordHits = 0;
  for (const kw of resolutionKeywords) { if (lowerDesc.includes(kw.toLowerCase())) keywordHits++; }
  metrics.contractDetailScore = { value: keywordHits, unit: `of ${resolutionKeywords.length} terms`, score: scoreBetween(keywordHits, 2, 15), signal: keywordHits >= 10 ? 'good' : keywordHits >= 5 ? 'neutral' : 'bad', context: keywordHits >= 10 ? 'Detailed contract' : keywordHits >= 5 ? 'Moderate detail' : 'Vague contract', _note: 'Keyword-based. Claude API analysis coming Phase 2.' };

  // 4. Has End Date
  const hasEndDate = gammaMarket.endDate != null;
  metrics.hasEndDate = { value: hasEndDate, unit: 'boolean', score: hasEndDate ? 8 : 3, signal: hasEndDate ? 'good' : 'warn', context: hasEndDate ? 'Defined timeline' : 'No end date — open-ended risk' };

  // 5. Resolution Type
  const outcomes = gammaMarket.outcomes ? JSON.parse(gammaMarket.outcomes) : [];
  const resType = outcomes.length <= 2 ? 'binary' : 'multi-outcome';
  metrics.resolutionType = { value: resType, unit: 'type', score: resType === 'binary' ? 8 : 6, signal: 'neutral', context: resType === 'binary' ? 'Simple Yes/No' : `${outcomes.length} outcomes` };

  // 6. Open Interest
  let oiValue = null;
  if (openInterest && Array.isArray(openInterest) && openInterest.length > 0) oiValue = openInterest[0].value != null ? parseFloat(openInterest[0].value) : null;
  metrics.openInterest = { value: fmt(oiValue, 2), unit: 'USD', score: oiValue != null ? scoreBetween(oiValue, 5000, 2000000) : null, signal: oiValue == null ? 'unavailable' : oiValue > 500000 ? 'good' : oiValue > 50000 ? 'neutral' : 'bad', context: oiValue != null ? `$${Math.round(oiValue).toLocaleString()} at stake` : null };

  // 7. OI / Dispute Bond ratio — NEW
  const disputeBond = 750;
  let oiBondRatio = null;
  if (oiValue != null) oiBondRatio = oiValue / disputeBond;
  metrics.oiDisputeRatio = { value: fmt(oiBondRatio, 0), unit: '×', score: oiBondRatio != null ? scoreBetween(oiBondRatio, 10, 2000) : null, signal: oiBondRatio == null ? 'unavailable' : oiBondRatio > 500 ? 'good' : oiBondRatio > 50 ? 'neutral' : 'bad', context: oiBondRatio != null ? (oiBondRatio > 50 ? 'Dispute economically viable' : 'Low incentive to dispute') : null };

  // 8. Largest Position — NEW
  let allPositions = [];
  if (holders && Array.isArray(holders)) {
    for (const side of holders) {
      if (side.holders && Array.isArray(side.holders)) {
        for (const h of side.holders) allPositions.push(parseFloat(h.amount || 0));
      }
    }
  }
  const largestPos = allPositions.length > 0 ? Math.max(...allPositions) : null;
  metrics.largestPosition = { value: fmt(largestPos, 2), unit: 'USD', score: null, signal: largestPos == null ? 'unavailable' : 'neutral', context: largestPos != null ? `$${Math.round(largestPos).toLocaleString()} — strong incentive for correct resolution` : null };

  // 9. Resolution Time Risk
  const endDate = gammaMarket.endDate;
  let daysLeft = null;
  if (endDate) { daysLeft = Math.floor((new Date(endDate) - new Date()) / (1000 * 60 * 60 * 24)); if (daysLeft < 0) daysLeft = 0; }
  metrics.resolutionTimeRisk = { value: daysLeft, unit: 'days remaining', score: daysLeft != null ? scoreBetween(daysLeft, 1, 180) : null, signal: daysLeft == null ? 'unavailable' : daysLeft > 60 ? 'good' : daysLeft > 14 ? 'neutral' : 'warn', context: daysLeft == null ? null : daysLeft > 60 ? 'No time pressure' : daysLeft > 14 ? 'Adequate time' : 'Resolution approaching' };

  // Pillar score
  const scorable = ['resolutionSource', 'descriptionLength', 'contractDetailScore', 'hasEndDate', 'resolutionType', 'openInterest', 'oiDisputeRatio', 'resolutionTimeRisk'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  const pillarScore = scores.length > 0 ? parseFloat((scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1)) : null;

  // Warning
  let warning = null;
  if (!hasResSource) warning = { type: 'danger', text: 'No named resolution source. Resolution depends on subjective consensus, which has historically caused disputes.' };
  else if (sourceQuality === 'subjective') warning = { type: 'warning', text: `Resolution source "${resSource}" is subjective. Consider whether this could be disputed.` };
  else if (keywordHits < 5) warning = { type: 'warning', text: 'Contract lacks detail. Few resolution criteria specified — edge cases may cause disputes.' };
  else if (pillarScore != null && pillarScore >= 7) warning = { type: 'info', text: 'Well-defined contract with clear resolution criteria and adequate stake.' };

  return { score: pillarScore, status: pillarScore >= 7 ? 'pass' : pillarScore >= 4 ? 'caution' : pillarScore != null ? 'fail' : 'unavailable', confidence: scores.length >= 6 ? 'high' : scores.length >= 4 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 9, warning, llmAnalysis: 'Not yet enabled — Claude API integration coming Phase 2', metrics };
}

// ─── MAIN HANDLER ────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only', status: 405 } });

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Provide a market slug.', status: 400 } });

  const marketSlug = slug.trim().toLowerCase();

  try {
    const gammaRes = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`);
    if (!gammaRes.ok) throw new Error(`GAMMA API failed: ${gammaRes.status}`);
    const markets = await gammaRes.json();
    if (!markets || markets.length === 0) return res.status(404).json({ error: { code: 'MARKET_NOT_FOUND', message: `No market found with slug '${marketSlug}'`, status: 404 } });

    const market = markets[0];
    const clobTokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
    const conditionId = market.conditionId;
    const primaryTokenId = clobTokenIds[0];
    const secondaryTokenId = clobTokenIds[1];
    if (!primaryTokenId) return res.status(400).json({ error: { code: 'NO_TOKEN_IDS', message: 'No CLOB token IDs.', status: 400 } });

    const startTime = Date.now();

    // Fetch all data in parallel
    const DOME_API_KEY = process.env.DOME_API_KEY;
const startTime = Date.now();

const results = await Promise.allSettled([
  fetch(`https://clob.polymarket.com/book?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),           // 0
  fetch(`https://clob.polymarket.com/spread?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),         // 1
  fetch(`https://clob.polymarket.com/midpoint?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),       // 2
  fetch(`https://clob.polymarket.com/prices-history?market=${primaryTokenId}&interval=1d&fidelity=30`).then(r => r.ok ? r.json() : null),  // 3
  fetch(`https://clob.polymarket.com/prices-history?market=${primaryTokenId}&interval=1h&fidelity=24`).then(r => r.ok ? r.json() : null),  // 4
  fetch(`https://data-api.polymarket.com/holders?market=${conditionId}`).then(r => r.ok ? r.json() : null),         // 5
  fetch(`https://data-api.polymarket.com/oi?market=${conditionId}`).then(r => r.ok ? r.json() : null),              // 6
  fetchDomeCandles(conditionId, 14, 1440, DOME_API_KEY),  // 7
  fetchDomeTrades(conditionId, 7, DOME_API_KEY, 3),       // 8
]);

    const orderbook = get(0), spread = get(1), midpoint = get(2);
const priceHistory30d = get(3), priceHistory24h = get(4);
const holders = get(5), openInterest = get(6);
const domeCandles14d = get(7);
const domeTrades = get(8);

const allTrades = Array.isArray(domeTrades) ? domeTrades : [];

    // Compute all 5 pillars
    const liquidity = computeLiquidityMetrics(orderbook, spread, midpoint, domeCandles14d, domeTrades);
    const discovery = computeDiscoveryMetrics(midpoint, priceHistory30d, priceHistory24h);
    const participation = computeParticipationMetrics(holders, allTrades);
    const maturity = computeMaturityMetrics(market, priceHistory30d, allTrades, orderbook, midpoint);
    const resolution = computeResolutionMetrics(market, openInterest, holders);

    const blockingIssues = [];
    const pillarEntries = { liquidity, discovery, participation, maturity, resolution };
    for (const [name, pillar] of Object.entries(pillarEntries)) {
      if (pillar.score != null && pillar.score < 3) {
        blockingIssues.push({ pillar: name, score: pillar.score, warning: pillar.warning?.text || `${name} score critically low` });
      }
    }
    const risk = blockingIssues.length > 0 ? { level: 'elevated', label: 'Blocking issues detected' } : { level: 'low', label: 'No blocking issues' };

const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No'];
return res.status(200).json({


  risk,
  blockingIssues,
  fetchTime: parseFloat(fetchTime),
  tradesSampled: allTrades.length,
  // ... rest stays the same

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

      scores: { liquidity: liquidity.score, discovery: discovery.score, participation: participation.score, maturity: maturity.score, resolution: resolution.score },
      pillars: { liquidity, discovery, participation, maturity, resolution },

      rawData: {
        orderbook: orderbook ? { bids: orderbook.bids ? orderbook.bids.length : 0, asks: orderbook.asks ? orderbook.asks.length : 0, bestBid: orderbook.bids?.[0] || null, bestAsk: orderbook.asks?.[0] || null } : null,
        spread: spread || null,
        midpoint: midpoint || null,
        priceHistory: { daily30d: priceHistory30d ? { points: Array.isArray(priceHistory30d.history) ? priceHistory30d.history.length : Array.isArray(priceHistory30d) ? priceHistory30d.length : 0 } : null, hourly24h: priceHistory24h ? { points: Array.isArray(priceHistory24h.history) ? priceHistory24h.history.length : Array.isArray(priceHistory24h) ? priceHistory24h.length : 0 } : null },
        holders: holders ? { sides: Array.isArray(holders) ? holders.length : 0, totalTopHolders: Array.isArray(holders) ? holders.reduce((sum, s) => sum + (s.holders ? s.holders.length : 0), 0) : 0 } : null,
        openInterest: openInterest || null,
        trades: { sampled: allTrades.length, batch1: Array.isArray(trades1) ? trades1.length : 0, batch2: Array.isArray(trades2) ? trades2.length : 0 },
      },
    });

  } catch (err) {
    console.error('Score endpoint error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
};
