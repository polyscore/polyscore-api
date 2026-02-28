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

function computeLiquidityMetrics(orderbook, spread, midpoint, allTrades) {
  const metrics = {};
  const midValue = midpoint?.mid ? parseFloat(midpoint.mid) : null;
  const fmt = (v, d) => v != null ? parseFloat(v.toFixed(d)) : null;

  // 1. Bid-ask spread
  const spreadValue = spread?.spread ? parseFloat(spread.spread) : null;
  let spreadPct = null;
  if (spreadValue != null && midValue != null && midValue > 0) spreadPct = (spreadValue / midValue) * 100;
  metrics.bidAskSpread = { value: fmt(spreadPct, 2), unit: '%', score: spreadPct != null ? (11 - scoreBetween(spreadPct, 1, 25)) : null, signal: spreadPct == null ? 'unavailable' : spreadPct < 3 ? 'good' : spreadPct < 10 ? 'neutral' : 'bad', context: spreadPct == null ? null : spreadPct < 2 ? 'Tight spread' : spreadPct < 5 ? 'Moderate' : 'Wide spread' };

  // 2. Depth at 2% (PRIMARY depth metric)
  let depthAt1 = null, depthAt2 = null, depthAt5 = null, bookImbalance = null;
  if (orderbook && midValue) {
    const bids = orderbook.bids || [], asks = orderbook.asks || [];
    let bidD1 = 0, askD1 = 0, bidD2 = 0, askD2 = 0, bidD5 = 0, askD5 = 0, totalBid = 0, totalAsk = 0;
    for (const bid of bids) { const p = parseFloat(bid.price), s = parseFloat(bid.size), d = ((midValue - p) / midValue) * 100; totalBid += p * s; if (d <= 1) bidD1 += p * s; if (d <= 2) bidD2 += p * s; if (d <= 5) bidD5 += p * s; }
    for (const ask of asks) { const p = parseFloat(ask.price), s = parseFloat(ask.size), d = ((p - midValue) / midValue) * 100; totalAsk += p * s; if (d <= 1) askD1 += p * s; if (d <= 2) askD2 += p * s; if (d <= 5) askD5 += p * s; }
    depthAt1 = bidD1 + askD1; depthAt2 = bidD2 + askD2; depthAt5 = bidD5 + askD5;
    bookImbalance = (totalBid + totalAsk) > 0 ? totalBid / (totalBid + totalAsk) : null;
  }
  metrics.depthAt2Pct = { value: fmt(depthAt2, 2), unit: 'USD', score: scoreBetween(depthAt2, 1000, 100000), signal: depthAt2 == null ? 'unavailable' : depthAt2 > 50000 ? 'good' : depthAt2 > 5000 ? 'neutral' : 'bad', context: depthAt2 == null ? null : depthAt2 > 50000 ? 'Strong depth' : depthAt2 > 5000 ? 'Moderate depth' : 'Thin orderbook' };
  metrics.depthAt1Pct = { value: fmt(depthAt1, 2), unit: 'USD', score: scoreBetween(depthAt1, 500, 50000), signal: depthAt1 == null ? 'unavailable' : depthAt1 > 20000 ? 'good' : depthAt1 > 2000 ? 'neutral' : 'bad', context: null };
  metrics.depthAt5Pct = { value: fmt(depthAt5, 2), unit: 'USD', score: scoreBetween(depthAt5, 2000, 200000), signal: depthAt5 == null ? 'unavailable' : depthAt5 > 50000 ? 'good' : depthAt5 > 10000 ? 'neutral' : 'bad', context: null };

  // 3. Kyle's Lambda — price impact per dollar traded
  let kyleLambda = null;
  if (allTrades && allTrades.length >= 10) {
    const sorted = [...allTrades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let totalLambda = 0, count = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prevPrice = parseFloat(sorted[i-1].price || 0);
      const currPrice = parseFloat(sorted[i].price || 0);
      const tradeValue = parseFloat(sorted[i].size || 0) * currPrice;
      if (tradeValue > 0.01 && prevPrice > 0) {
        totalLambda += Math.abs(currPrice - prevPrice) / tradeValue;
        count++;
      }
    }
    if (count > 0) kyleLambda = totalLambda / count;
  }
  metrics.kyleLambda = { value: fmt(kyleLambda, 6), unit: 'λ', score: kyleLambda != null ? (11 - scoreBetween(kyleLambda, 0.0001, 0.01)) : null, signal: kyleLambda == null ? 'unavailable' : kyleLambda < 0.001 ? 'good' : kyleLambda < 0.005 ? 'neutral' : 'bad', context: kyleLambda == null ? null : kyleLambda < 0.001 ? 'Low price impact' : kyleLambda < 0.005 ? 'Moderate impact' : 'High price impact' };

  // 4. Slippage estimate ($5K order) — walk the ask side of the book
  let slippage5k = null;
  if (orderbook && midValue) {
    const asks = [...(orderbook.asks || [])].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    let remaining = 5000, weightedPrice = 0, filledQty = 0;
    for (const ask of asks) {
      if (remaining <= 0) break;
      const p = parseFloat(ask.price), s = parseFloat(ask.size);
      const dollarAvail = p * s;
      const dollarFill = Math.min(remaining, dollarAvail);
      const qtyFill = dollarFill / p;
      weightedPrice += p * qtyFill;
      filledQty += qtyFill;
      remaining -= dollarFill;
    }
    if (filledQty > 0 && midValue > 0) {
      const avgPrice = weightedPrice / filledQty;
      slippage5k = ((avgPrice - midValue) / midValue) * 100;
    }
  }
  metrics.slippage5k = { value: fmt(slippage5k, 2), unit: '%', score: slippage5k != null ? (11 - scoreBetween(slippage5k, 0.5, 15)) : null, signal: slippage5k == null ? 'unavailable' : slippage5k < 1 ? 'good' : slippage5k < 5 ? 'neutral' : 'bad', context: slippage5k == null ? null : slippage5k < 1 ? 'Minimal impact' : slippage5k < 5 ? 'Moderate slippage' : 'Heavy slippage — use limit orders' };

  // 5. Amihud Illiquidity Ratio — avg(|daily return| / daily volume)
  let amihud = null;
  if (allTrades && allTrades.length >= 20) {
    const nowSec = Date.now() / 1000;
    const sevenDaysAgo = nowSec - 86400 * 7;
    const dailyData = {};
    for (const trade of allTrades) {
      const ts = trade.timestamp || 0;
      if (ts < sevenDaysAgo) continue;
      const day = Math.floor(ts / 86400);
      if (!dailyData[day]) dailyData[day] = { prices: [], volume: 0 };
      dailyData[day].prices.push(parseFloat(trade.price || 0));
      dailyData[day].volume += parseFloat(trade.size || 0) * parseFloat(trade.price || 0);
    }
    const dayKeys = Object.keys(dailyData).sort();
    if (dayKeys.length >= 2) {
      let totalAmihud = 0, count = 0;
      for (let i = 1; i < dayKeys.length; i++) {
        const prev = dailyData[dayKeys[i-1]], curr = dailyData[dayKeys[i]];
        const prevAvg = prev.prices.reduce((a,b) => a+b, 0) / prev.prices.length;
        const currAvg = curr.prices.reduce((a,b) => a+b, 0) / curr.prices.length;
        if (prevAvg > 0 && curr.volume > 0) {
          totalAmihud += Math.abs((currAvg - prevAvg) / prevAvg) / curr.volume;
          count++;
        }
      }
      if (count > 0) amihud = (totalAmihud / count) * 1e6; // scale for readability
    }
  }
  metrics.amihudIlliquidity = { value: fmt(amihud, 2), unit: '×10⁶', score: amihud != null ? (11 - scoreBetween(amihud, 0.01, 5)) : null, signal: amihud == null ? 'unavailable' : amihud < 0.5 ? 'good' : amihud < 2 ? 'neutral' : 'bad', context: amihud == null ? null : amihud < 0.5 ? 'Liquid market' : amihud < 2 ? 'Moderate liquidity' : 'Illiquid' };

  // 6. Book Imbalance
  metrics.bookImbalance = { value: fmt(bookImbalance, 3), unit: 'ratio', score: scoreCloseTo(bookImbalance, 0.5, 0.5), signal: bookImbalance == null ? 'unavailable' : Math.abs(bookImbalance - 0.5) < 0.15 ? 'good' : Math.abs(bookImbalance - 0.5) < 0.3 ? 'neutral' : 'bad', context: bookImbalance == null ? null : Math.abs(bookImbalance - 0.5) < 0.15 ? 'Balanced' : bookImbalance < 0.35 ? 'Ask-heavy' : bookImbalance > 0.65 ? 'Bid-heavy' : 'Slightly imbalanced' };

  // 7-9. Volume metrics
  let volume24h = null, volume7d = null, volumeTrend = null;
  if (allTrades && allTrades.length > 0) {
    const now = Date.now() / 1000;
    let vol24 = 0, vol7d = 0, volPrior7d = 0;
    for (const trade of allTrades) {
      const ts = trade.timestamp || 0, value = parseFloat(trade.size || 0) * parseFloat(trade.price || 0);
      if (ts >= now - 86400) vol24 += value;
      if (ts >= now - 86400 * 7) vol7d += value;
      if (ts >= now - 86400 * 14 && ts < now - 86400 * 7) volPrior7d += value;
    }
    volume24h = vol24; volume7d = vol7d;
    if (volPrior7d > 0) volumeTrend = ((vol7d - volPrior7d) / volPrior7d) * 100;
    else if (vol7d > 0) volumeTrend = 100;
  }
  metrics.volume24h = { value: fmt(volume24h, 2), unit: 'USD', score: scoreBetween(volume24h, 1000, 500000), signal: volume24h == null ? 'unavailable' : volume24h > 100000 ? 'good' : volume24h > 10000 ? 'neutral' : 'bad', context: volume24h == null ? null : volume24h > 100000 ? 'Active trading' : volume24h > 10000 ? 'Moderate activity' : 'Low activity' };
  metrics.volume7d = { value: fmt(volume7d, 2), unit: 'USD', score: scoreBetween(volume7d, 5000, 2000000), signal: volume7d == null ? 'unavailable' : volume7d > 500000 ? 'good' : volume7d > 50000 ? 'neutral' : 'bad', context: null };
  metrics.volumeTrend = { value: fmt(volumeTrend, 1), unit: '%', score: volumeTrend != null ? scoreBetween(volumeTrend, -50, 100) : null, signal: volumeTrend == null ? 'unavailable' : volumeTrend > 10 ? 'good' : volumeTrend > -10 ? 'neutral' : 'bad', context: volumeTrend == null ? null : volumeTrend > 20 ? 'Growing interest' : volumeTrend > -10 ? 'Stable' : 'Declining' };

  // Pillar score — weight the primary metrics higher
  const primaryMetrics = ['bidAskSpread', 'depthAt2Pct', 'kyleLambda', 'slippage5k', 'bookImbalance', 'volume24h', 'volumeTrend'];
  const scores = primaryMetrics.map(k => metrics[k]?.score).filter(s => s != null);
  const pillarScore = scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null;

  // Warning
  let warning = null;
  if (slippage5k != null && slippage5k > 5) warning = { type: 'danger', text: `Heavy slippage. A $5K order would move the price by ${fmt(slippage5k, 1)}%. Consider smaller positions or limit orders.` };
  else if (depthAt2 != null && depthAt2 < 5000) warning = { type: 'warning', text: `Thin orderbook. Only $${Math.round(depthAt2).toLocaleString()} within 2% of midpoint.` };
  else if (bookImbalance != null && Math.abs(bookImbalance - 0.5) > 0.3) warning = { type: 'warning', text: `Imbalanced book. ${bookImbalance < 0.35 ? 'Sellers heavily outweigh buyers' : 'Buyers heavily outweigh sellers'}.` };
  else if (pillarScore != null && pillarScore >= 7) warning = { type: 'info', text: 'Good liquidity. Tight spreads and adequate depth for most position sizes.' };

  return { score: pillarScore, status: pillarScore >= 7 ? 'pass' : pillarScore >= 4 ? 'caution' : pillarScore != null ? 'fail' : 'unavailable', confidence: scores.length >= 5 ? 'high' : scores.length >= 3 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 12, warning, metrics };
}

// ─── DISCOVERY PILLAR ────────────────────────────────────────

function computeDiscoveryMetrics(midpoint, priceHistory30d) {
  const metrics = {};
  const midValue = midpoint?.mid ? parseFloat(midpoint.mid) : null;
  let history = [];
  if (priceHistory30d) { const raw = Array.isArray(priceHistory30d.history) ? priceHistory30d.history : Array.isArray(priceHistory30d) ? priceHistory30d : []; history = [...raw].sort((a, b) => (a.t || 0) - (b.t || 0)); }

  metrics.currentPrice = { value: midValue, unit: 'probability', score: null, signal: midValue == null ? 'unavailable' : 'neutral' };

  let priceChange24h = null;
  if (history.length >= 2 && midValue != null) { const prior = history[history.length - 2]?.p; if (prior != null && prior > 0) priceChange24h = ((midValue - prior) / prior) * 100; }
  metrics.priceChange24h = { value: priceChange24h != null ? parseFloat(priceChange24h.toFixed(2)) : null, unit: '%', score: null, signal: priceChange24h == null ? 'unavailable' : Math.abs(priceChange24h) > 10 ? 'warn' : 'neutral' };

  const last7 = history.slice(-7);
  let low7d = null, high7d = null;
  if (last7.length > 0) { const prices = last7.map(c => c.p).filter(p => p != null); if (prices.length > 0) { low7d = Math.min(...prices); high7d = Math.max(...prices); } }
  metrics.priceRange7d = { value: low7d != null ? [parseFloat(low7d.toFixed(3)), parseFloat(high7d.toFixed(3))] : null, unit: 'range', score: null, signal: low7d == null ? 'unavailable' : 'neutral' };

  let realizedVol7d = null;
  if (last7.length >= 3) { const prices = last7.map(c => c.p).filter(p => p != null); const returns = []; for (let i = 1; i < prices.length; i++) { if (prices[i-1] > 0) returns.push((prices[i] - prices[i-1]) / prices[i-1]); } if (returns.length >= 2) { const mean = returns.reduce((a,b) => a+b, 0) / returns.length; const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length; realizedVol7d = Math.sqrt(variance) * 100; } }
  metrics.realizedVol7d = { value: realizedVol7d != null ? parseFloat(realizedVol7d.toFixed(2)) : null, unit: '%', score: realizedVol7d != null ? scoreCloseTo(realizedVol7d, 6, 30) : null, signal: realizedVol7d == null ? 'unavailable' : realizedVol7d > 2 && realizedVol7d < 15 ? 'good' : realizedVol7d < 1 ? 'neutral' : 'warn' };

  let autocorrelation = null;
  if (history.length >= 5) { const prices = history.map(c => c.p).filter(p => p != null); const returns = []; for (let i = 1; i < prices.length; i++) { if (prices[i-1] > 0) returns.push((prices[i] - prices[i-1]) / prices[i-1]); } if (returns.length >= 4) { const mean = returns.reduce((a,b) => a+b, 0) / returns.length; let num = 0, den = 0; for (let i = 1; i < returns.length; i++) num += (returns[i] - mean) * (returns[i-1] - mean); for (let i = 0; i < returns.length; i++) den += Math.pow(returns[i] - mean, 2); if (den > 0) autocorrelation = num / den; } }
  metrics.autocorrelation = { value: autocorrelation != null ? parseFloat(autocorrelation.toFixed(3)) : null, unit: 'corr', score: autocorrelation != null ? scoreCloseTo(autocorrelation, 0, 1) : null, signal: autocorrelation == null ? 'unavailable' : Math.abs(autocorrelation) < 0.2 ? 'good' : Math.abs(autocorrelation) < 0.5 ? 'neutral' : 'warn' };

  let priceEfficiency = null;
  if (metrics.autocorrelation.score != null && metrics.realizedVol7d.score != null) priceEfficiency = parseFloat((metrics.autocorrelation.score * 0.6 + metrics.realizedVol7d.score * 0.4).toFixed(1));
  metrics.priceEfficiency = { value: priceEfficiency, unit: '/10', score: priceEfficiency != null ? Math.round(priceEfficiency) : null, signal: priceEfficiency == null ? 'unavailable' : priceEfficiency >= 7 ? 'good' : priceEfficiency >= 4 ? 'neutral' : 'bad' };

  const scorable = ['realizedVol7d', 'autocorrelation', 'priceEfficiency'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  return { score: scores.length > 0 ? parseFloat((scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1)) : null, confidence: scores.length >= 3 ? 'high' : scores.length >= 2 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 6, metrics };
}

// ─── PARTICIPATION PILLAR ────────────────────────────────────

function computeParticipationMetrics(holders, allTrades) {
  const metrics = {};

  // Get holder positions from top holders endpoint
  let allPositions = [];
  if (holders && Array.isArray(holders)) {
    for (const side of holders) {
      if (side.holders && Array.isArray(side.holders)) {
        for (const h of side.holders) allPositions.push(parseFloat(h.amount || 0));
      }
    }
  }

  // Count unique wallets from trades (much more accurate than top holders)
  const uniqueWallets = new Set();
  const tradeSizes = [];
  if (allTrades && allTrades.length > 0) {
    for (const trade of allTrades) {
      if (trade.proxyWallet) uniqueWallets.add(trade.proxyWallet);
      const size = parseFloat(trade.size || 0) * parseFloat(trade.price || 0);
      if (size > 0) tradeSizes.push(size);
    }
  }

  const walletCount = uniqueWallets.size;
  metrics.uniqueWallets = { value: walletCount, unit: 'count (from recent trades)', score: scoreBetween(walletCount, 10, 1000), signal: walletCount === 0 ? 'unavailable' : walletCount > 200 ? 'good' : walletCount > 50 ? 'neutral' : 'bad' };

  // Concentration from top holders (still useful)
  const sorted = [...allPositions].sort((a, b) => b - a);
  const totalAmount = sorted.reduce((a, b) => a + b, 0);

  let top5Pct = null;
  if (totalAmount > 0 && sorted.length >= 5) top5Pct = (sorted.slice(0, 5).reduce((a,b) => a+b, 0) / totalAmount) * 100;
  metrics.top5Concentration = { value: top5Pct != null ? parseFloat(top5Pct.toFixed(1)) : null, unit: '%', score: top5Pct != null ? (11 - scoreBetween(top5Pct, 20, 90)) : null, signal: top5Pct == null ? 'unavailable' : top5Pct < 30 ? 'good' : top5Pct < 60 ? 'neutral' : 'bad' };

  let top10Pct = null;
  if (totalAmount > 0 && sorted.length >= 10) top10Pct = (sorted.slice(0, 10).reduce((a,b) => a+b, 0) / totalAmount) * 100;
  metrics.top10Concentration = { value: top10Pct != null ? parseFloat(top10Pct.toFixed(1)) : null, unit: '%', score: top10Pct != null ? (11 - scoreBetween(top10Pct, 30, 95)) : null, signal: top10Pct == null ? 'unavailable' : top10Pct < 50 ? 'good' : top10Pct < 75 ? 'neutral' : 'bad' };

  // Gini from top holders
  let gini = null;
  if (sorted.length >= 2 && totalAmount > 0) { const n = sorted.length; const asc = [...allPositions].sort((a,b) => a-b); let s = 0; for (let i = 0; i < n; i++) s += (2*(i+1) - n - 1) * asc[i]; gini = Math.max(0, Math.min(1, s / (n * totalAmount))); }
  metrics.giniCoefficient = { value: gini != null ? parseFloat(gini.toFixed(3)) : null, unit: 'index', score: gini != null ? (11 - scoreBetween(gini, 0.2, 0.95)) : null, signal: gini == null ? 'unavailable' : gini < 0.4 ? 'good' : gini < 0.7 ? 'neutral' : 'bad' };

  // Whale and retail from trade sizes (more representative than top holders)
  const whaleCount = tradeSizes.filter(s => s > 10000).length;
  const retailCount = tradeSizes.filter(s => s < 100).length;
  const retailRatio = tradeSizes.length > 0 ? (retailCount / tradeSizes.length) * 100 : null;

  metrics.whaleCount = { value: whaleCount, unit: 'trades > $10K', score: null, signal: tradeSizes.length === 0 ? 'unavailable' : 'neutral' };
  metrics.retailRatio = { value: retailRatio != null ? parseFloat(retailRatio.toFixed(1)) : null, unit: '% of trades < $100', score: scoreBetween(retailRatio, 5, 70), signal: retailRatio == null ? 'unavailable' : retailRatio > 50 ? 'good' : retailRatio > 20 ? 'neutral' : 'bad' };

  // Median trade size
  let medianTrade = null;
  if (tradeSizes.length > 0) {
    const sortedTrades = [...tradeSizes].sort((a, b) => a - b);
    const mid = Math.floor(sortedTrades.length / 2);
    medianTrade = sortedTrades.length % 2 !== 0 ? sortedTrades[mid] : (sortedTrades[mid-1] + sortedTrades[mid]) / 2;
  }
  metrics.medianTradeSize = { value: medianTrade != null ? parseFloat(medianTrade.toFixed(2)) : null, unit: 'USD', score: null, signal: medianTrade == null ? 'unavailable' : 'neutral' };

  const scorable = ['uniqueWallets', 'top5Concentration', 'top10Concentration', 'giniCoefficient', 'retailRatio'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  return { score: scores.length > 0 ? parseFloat((scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1)) : null, confidence: scores.length >= 4 ? 'high' : scores.length >= 2 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 7, metrics };
}

// ─── MATURITY PILLAR ─────────────────────────────────────────

function computeMaturityMetrics(gammaMarket, priceHistory30d, allTrades) {
  const metrics = {};
  const now = new Date();

  const startTime = gammaMarket.startDate || gammaMarket.createdAt;
  let marketAge = null;
  if (startTime) marketAge = Math.floor((now - new Date(startTime)) / (1000 * 60 * 60 * 24));
  metrics.marketAge = { value: marketAge, unit: 'days', score: scoreBetween(marketAge, 1, 180), signal: marketAge == null ? 'unavailable' : marketAge > 60 ? 'good' : marketAge > 14 ? 'neutral' : 'bad' };

  const endTime = gammaMarket.endDate;
  let daysToResolution = null;
  if (endTime) { daysToResolution = Math.floor((new Date(endTime) - now) / (1000 * 60 * 60 * 24)); if (daysToResolution < 0) daysToResolution = 0; }
  metrics.daysToResolution = { value: daysToResolution, unit: 'days', score: null, signal: daysToResolution == null ? 'unavailable' : daysToResolution > 30 ? 'good' : daysToResolution > 7 ? 'neutral' : 'warn' };

  let lifecycleStage = null;
  if (marketAge != null && daysToResolution != null) { const total = marketAge + daysToResolution; const pct = total > 0 ? (marketAge / total) * 100 : 0; if (pct < 25) lifecycleStage = 'Early'; else if (pct < 50) lifecycleStage = 'Growth'; else if (pct < 75) lifecycleStage = 'Mature'; else if (pct < 90) lifecycleStage = 'Late'; else lifecycleStage = 'Near Expiry'; }
  const stageScores = { 'Early': 5, 'Growth': 8, 'Mature': 10, 'Late': 6, 'Near Expiry': 3 };
  metrics.lifecycleStage = { value: lifecycleStage, unit: 'stage', score: lifecycleStage ? stageScores[lifecycleStage] : null, signal: lifecycleStage == null ? 'unavailable' : lifecycleStage === 'Mature' || lifecycleStage === 'Growth' ? 'good' : lifecycleStage === 'Near Expiry' ? 'warn' : 'neutral' };

  let priceStability = null;
  let historyPrices = [];
  if (priceHistory30d) { const raw = Array.isArray(priceHistory30d.history) ? priceHistory30d.history : Array.isArray(priceHistory30d) ? priceHistory30d : []; historyPrices = raw.map(c => c.p).filter(p => p != null); }
  if (historyPrices.length >= 5) { const mean = historyPrices.reduce((a,b) => a+b, 0) / historyPrices.length; const variance = historyPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / historyPrices.length; priceStability = Math.sqrt(variance); }
  metrics.priceStability = { value: priceStability != null ? parseFloat(priceStability.toFixed(4)) : null, unit: 'σ', score: priceStability != null ? (11 - scoreBetween(priceStability, 0.01, 0.3)) : null, signal: priceStability == null ? 'unavailable' : priceStability < 0.05 ? 'good' : priceStability < 0.15 ? 'neutral' : 'bad' };

  let activityTrend = null;
  if (allTrades && allTrades.length > 0) {
    const nowSec = Date.now() / 1000;
    const recent = allTrades.filter(t => (t.timestamp||0) >= nowSec - 86400*7).length;
    const older = allTrades.filter(t => { const ts = t.timestamp||0; return ts >= nowSec - 86400*14 && ts < nowSec - 86400*7; }).length;
    if (older > 0) activityTrend = recent / older;
    else if (recent > 0) activityTrend = 2.0;
  }
  metrics.activityTrend = { value: activityTrend != null ? parseFloat(activityTrend.toFixed(2)) : null, unit: 'ratio', score: activityTrend != null ? scoreBetween(activityTrend, 0.2, 3) : null, signal: activityTrend == null ? 'unavailable' : activityTrend > 1.2 ? 'good' : activityTrend > 0.5 ? 'neutral' : 'bad' };

  const totalVolume = parseFloat(gammaMarket.volume || 0);
  metrics.totalVolume = { value: totalVolume > 0 ? parseFloat(totalVolume.toFixed(2)) : null, unit: 'USD', score: scoreBetween(totalVolume, 10000, 5000000), signal: totalVolume > 1000000 ? 'good' : totalVolume > 100000 ? 'neutral' : 'bad' };

  const scorable = ['marketAge', 'lifecycleStage', 'priceStability', 'activityTrend', 'totalVolume'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  return { score: scores.length > 0 ? parseFloat((scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1)) : null, confidence: scores.length >= 4 ? 'high' : scores.length >= 3 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 6, metrics };
}

// ─── RESOLUTION PILLAR ───────────────────────────────────────

function computeResolutionMetrics(gammaMarket, openInterest) {
  const metrics = {};
  const desc = gammaMarket.description || '';

  const resSource = gammaMarket.resolutionSource || null;
  const hasResSource = resSource != null && resSource.length > 0;
  metrics.resolutionSource = { value: hasResSource ? resSource : 'Not specified', unit: 'source', score: hasResSource ? 8 : 2, signal: hasResSource ? 'good' : 'bad' };

  const descLength = desc.length;
  metrics.descriptionLength = { value: descLength, unit: 'chars', score: scoreBetween(descLength, 50, 1000), signal: descLength > 500 ? 'good' : descLength > 200 ? 'neutral' : 'bad' };

  const resolutionKeywords = ['resolve', 'resolution', 'will resolve to', 'yes if', 'no if', 'otherwise', 'source', 'oracle', 'official', 'deadline', 'by', 'before', 'after', 'criteria', 'qualify', 'does not qualify', 'consensus', 'reporting', 'announced', 'defined as', 'means', 'specifically', 'edge case', 'exception', 'excluding', 'including', 'AM ET', 'PM ET', 'UTC', 'EST'];
  const lowerDesc = desc.toLowerCase();
  let keywordHits = 0;
  for (const kw of resolutionKeywords) { if (lowerDesc.includes(kw.toLowerCase())) keywordHits++; }
  metrics.contractDetailScore = { value: keywordHits, unit: `of ${resolutionKeywords.length} key terms found`, score: scoreBetween(keywordHits, 2, 15), signal: keywordHits >= 10 ? 'good' : keywordHits >= 5 ? 'neutral' : 'bad' };

  const hasEndDate = gammaMarket.endDate != null;
  metrics.hasEndDate = { value: hasEndDate, unit: 'boolean', score: hasEndDate ? 8 : 3, signal: hasEndDate ? 'good' : 'warn' };

  const outcomes = gammaMarket.outcomes ? JSON.parse(gammaMarket.outcomes) : [];
  const resType = outcomes.length <= 2 ? 'binary' : 'multi-outcome';
  metrics.resolutionType = { value: resType, unit: 'type', score: resType === 'binary' ? 8 : 6, signal: 'neutral' };

  // Open interest from /oi endpoint
  let oiValue = null;
  if (openInterest && Array.isArray(openInterest) && openInterest.length > 0) {
    oiValue = openInterest[0].value != null ? parseFloat(openInterest[0].value) : null;
  }
  metrics.openInterest = { value: oiValue != null ? parseFloat(oiValue.toFixed(2)) : null, unit: 'USD', score: oiValue != null ? scoreBetween(oiValue, 5000, 2000000) : null, signal: oiValue == null ? 'unavailable' : oiValue > 500000 ? 'good' : oiValue > 50000 ? 'neutral' : 'bad' };

  const endDate = gammaMarket.endDate;
  let daysLeft = null;
  if (endDate) { daysLeft = Math.floor((new Date(endDate) - new Date()) / (1000 * 60 * 60 * 24)); if (daysLeft < 0) daysLeft = 0; }
  metrics.resolutionTimeRisk = { value: daysLeft, unit: 'days remaining', score: daysLeft != null ? scoreBetween(daysLeft, 1, 180) : null, signal: daysLeft == null ? 'unavailable' : daysLeft > 60 ? 'good' : daysLeft > 14 ? 'neutral' : 'warn' };

  const scorable = ['resolutionSource', 'descriptionLength', 'contractDetailScore', 'hasEndDate', 'resolutionType', 'openInterest', 'resolutionTimeRisk'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  return { score: scores.length > 0 ? parseFloat((scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1)) : null, confidence: scores.length >= 5 ? 'high' : scores.length >= 3 ? 'medium' : 'low', metricsComputed: scores.length, metricsTotal: 7, llmAnalysis: 'Not yet enabled — Claude API integration coming soon', metrics };
}

// ─── COMPOSITE POLYSCORE ─────────────────────────────────────

function computePolyScore(liquidity, discovery, participation, maturity, resolution) {
  const weights = { liquidity: 0.25, discovery: 0.15, participation: 0.20, maturity: 0.15, resolution: 0.25 };
  const pillarScores = { liquidity: liquidity.score, discovery: discovery.score, participation: participation.score, maturity: maturity.score, resolution: resolution.score };
  let weightedSum = 0, totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) { if (pillarScores[key] != null) { weightedSum += pillarScores[key] * weight; totalWeight += weight; } }
  if (totalWeight === 0) return null;
  return parseFloat((weightedSum / totalWeight).toFixed(1));
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

    // Fetch all data in parallel — including 2 batches of trades and the correct OI endpoint
    const results = await Promise.allSettled([
      fetch(`https://clob.polymarket.com/book?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://clob.polymarket.com/spread?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://clob.polymarket.com/midpoint?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://clob.polymarket.com/prices-history?market=${primaryTokenId}&interval=1d&fidelity=30`).then(r => r.ok ? r.json() : null),
      fetch(`https://clob.polymarket.com/prices-history?market=${primaryTokenId}&interval=1h&fidelity=24`).then(r => r.ok ? r.json() : null),
      fetch(`https://data-api.polymarket.com/holders?market=${conditionId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://data-api.polymarket.com/oi?market=${conditionId}`).then(r => r.ok ? r.json() : null),
      fetch(`https://data-api.polymarket.com/trades?market=${conditionId}&limit=1000&offset=0`).then(r => r.ok ? r.json() : null),
      fetch(`https://data-api.polymarket.com/trades?market=${conditionId}&limit=1000&offset=1000`).then(r => r.ok ? r.json() : null),
    ]);

    const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const get = (i) => results[i].status === 'fulfilled' ? results[i].value : null;

    const orderbook = get(0), spread = get(1), midpoint = get(2);
    const priceHistory30d = get(3), priceHistory24h = get(4);
    const holders = get(5), openInterest = get(6);
    const trades1 = get(7), trades2 = get(8);

    // Merge trade batches
    const allTrades = [
      ...(Array.isArray(trades1) ? trades1 : []),
      ...(Array.isArray(trades2) ? trades2 : []),
    ];

    // Compute all 5 pillars
    const liquidity = computeLiquidityMetrics(orderbook, spread, midpoint, allTrades);
    const discovery = computeDiscoveryMetrics(midpoint, priceHistory30d);
    const participation = computeParticipationMetrics(holders, allTrades);
    const maturity = computeMaturityMetrics(market, priceHistory30d, allTrades);
    const resolution = computeResolutionMetrics(market, openInterest);

    const polyscore = computePolyScore(liquidity, discovery, participation, maturity, resolution);
    const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No'];

    return res.status(200).json({
      polyscore,
      polyscoreStatus: polyscore != null ? 'All 5 pillars computed' : 'Partial — some pillars unavailable',
      fetchTime: parseFloat(fetchTime),
      tradesSampled: allTrades.length,

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

      scores: { overall: polyscore, liquidity: liquidity.score, discovery: discovery.score, participation: participation.score, maturity: maturity.score, resolution: resolution.score },
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
