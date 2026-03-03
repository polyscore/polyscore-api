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

  // 1. Bid-Ask Spread (%)
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

  // 2. Depth at 2%
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

  // 3. Book Imbalance (within 2% of midpoint)
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

  // 4. Spread as % of Edge
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

  // 5. Volume 24h (Dome candles)
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
        vol += (shares / 1000000) * meanPrice;
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

  // 6. Volume Trend (7d vs prior 7d)
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
  const cappedVolTrend = volumeTrend != null ? Math.max(-200, Math.min(200, volumeTrend)) : null;
  const volTrendCapped = volumeTrend != null && Math.abs(volumeTrend) > 200;
  metrics.volumeTrend = {
    value: fmt(cappedVolTrend, 1),
    unit: '%',
    score: volumeTrend != null ? scoreBetween(volumeTrend, -50, 100) : null,
    signal: volumeTrend == null ? 'unavailable' : volumeTrend > 10 ? 'good' : volumeTrend > -10 ? 'neutral' : 'bad',
    context: volumeTrend == null ? null
      : volTrendCapped && volumeTrend > 0 ? 'New or surging market — volume up sharply'
      : volTrendCapped && volumeTrend < 0 ? 'Volume collapsed'
      : volumeTrend > 20 ? 'Growing interest'
      : volumeTrend > -10 ? 'Stable activity'
      : 'Declining — market losing attention',
  };

  // 7. Kyle's Lambda (Dome trades — filtered to trades > $50)
  let kyleLambda = null;
  if (domeTrades && domeTrades.length >= 10) {
    const minTradeValue = 50;
    const sorted = [...domeTrades]
      .map(t => ({
        price: parseFloat(t.price || 0),
        value: parseFloat(t.shares_normalized || 0) * parseFloat(t.price || 0),
        timestamp: t.timestamp || 0,
      }))
      .filter(t => t.value >= minTradeValue && t.price > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (sorted.length >= 10) {
      let totalLambda = 0, count = 0;
      for (let i = 1; i < sorted.length; i++) {
        const priceDelta = Math.abs(sorted[i].price - sorted[i-1].price);
        if (sorted[i].value > 0) {
          totalLambda += priceDelta / sorted[i].value;
          count++;
        }
      }
      if (count > 0) kyleLambda = totalLambda / count;
    }
  }
  metrics.kyleLambda = {
    value: fmt(kyleLambda, 6),
    unit: 'λ',
    score: kyleLambda != null ? (11 - scoreBetween(kyleLambda, 0.00005, 0.005)) : null,
    signal: kyleLambda == null ? 'unavailable' : kyleLambda < 0.0005 ? 'good' : kyleLambda < 0.002 ? 'neutral' : 'bad',
    context: kyleLambda == null ? null
      : kyleLambda < 0.0005 ? 'Stable — trades absorbed without moving price'
      : kyleLambda < 0.002 ? 'Moderate price impact'
      : 'Fragile — even small trades move the price',
  };

  // 8. Time Since Last Trade
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

  // Pillar score
  const scoredMetrics = ['bidAskSpread', 'depthAt2Pct', 'bookImbalance', 'spreadEdgePct', 'volume24h', 'volumeTrend', 'kyleLambda', 'timeSinceLastTrade'];
  const scores = scoredMetrics.map(k => metrics[k]?.score).filter(s => s != null);
  const pillarScore = scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null;

  // Warnings
  const warnings = [];
  const isStale = timeSinceLastTrade != null && timeSinceLastTrade > 48;
  const isThin = depthAt2 != null && depthAt2 < 5000;
  const isWideSpread = spreadPct != null && spreadPct > 10;
  const isDeclining = volumeTrend != null && volumeTrend < -40;
  const isFragile = kyleLambda != null && kyleLambda > 0.002;
  const isNoBuyers = bookImbalance != null && bookImbalance < 0.2;
  const isNoSellers = bookImbalance != null && bookImbalance > 0.8;
  const isExpensiveEdge = spreadEdgePct != null && spreadEdgePct > 40;
  const isDead = volume24h != null && volume24h === 0;

  if (isStale && isThin && isDeclining) {
    warnings.push({ type: 'danger', text: 'Ghost market — last trade ' + fmt(timeSinceLastTrade / 24, 1) + ' days ago, only $' + Math.round(depthAt2).toLocaleString() + ' in the book, and activity down ' + fmt(Math.abs(volumeTrend), 0) + '%. This market exists on paper only.' });
  } else if (isDeclining && (isStale || isDead)) {
    warnings.push({ type: 'danger', text: 'Dying market — volume down ' + fmt(Math.abs(volumeTrend), 0) + '% and ' + (isDead ? 'no trades today' : 'last trade ' + fmt(timeSinceLastTrade / 24, 1) + ' days ago') + '. You probably can\'t exit at a fair price.' });
  } else if (isNoBuyers && isDeclining) {
    warnings.push({ type: 'danger', text: 'Trapped — no buyers near the price and activity declining. If you enter, you may not be able to get out.' });
  } else if (isStale && isWideSpread) {
    warnings.push({ type: 'danger', text: 'Stale and expensive — last trade ' + fmt(timeSinceLastTrade / 24, 1) + ' days ago with a ' + fmt(spreadPct, 1) + '% spread. The price you see is probably not what you\'ll get.' });
  } else if (!isWideSpread && isThin) {
    warnings.push({ type: 'warning', text: 'Price mirage — spread looks tight but only $' + Math.round(depthAt2).toLocaleString() + ' behind it. One order will blow through the book.' });
  } else if (isFragile && isThin) {
    warnings.push({ type: 'warning', text: 'Fragile and thin — small trades are moving the price and there\'s little depth. This price is noise, not signal.' });
  }

  if (warnings.length === 0) {
    if (isExpensiveEdge) {
      const edgeStr = midValue != null ? 'Market at ' + Math.round(midValue * 100) + '¢' : 'Near-certain market';
      warnings.push({ type: 'warning', text: edgeStr + ' — the spread consumes ' + fmt(spreadEdgePct, 0) + '% of your potential profit. The math may not work.' });
    } else if (isWideSpread) {
      warnings.push({ type: 'warning', text: 'Wide spread — you\'ll pay ' + fmt(spreadPct, 1) + '% just to enter this trade.' });
    } else if (isNoSellers) {
      warnings.push({ type: 'warning', text: 'No sellers near the price — buying may push the price up significantly.' });
    } else if (isNoBuyers) {
      warnings.push({ type: 'warning', text: 'No buyers near the price — you may struggle to exit your position.' });
    } else if (isDead) {
      warnings.push({ type: 'warning', text: 'No trades in the last 24 hours — this price may be stale and unreliable.' });
    } else if (isStale) {
      warnings.push({ type: 'warning', text: 'Last trade was ' + fmt(timeSinceLastTrade / 24, 1) + ' days ago — the current price may not reflect reality.' });
    } else if (isDeclining) {
      warnings.push({ type: 'warning', text: 'Activity dropped ' + fmt(Math.abs(volumeTrend), 0) + '% this week — this market is losing attention.' });
    } else if (isThin) {
      warnings.push({ type: 'warning', text: 'Thin orderbook — only $' + Math.round(depthAt2).toLocaleString() + ' within 2% of the price.' });
    } else if (isFragile) {
      warnings.push({ type: 'warning', text: 'Fragile market — even small trades are moving the price significantly.' });
    }
  }

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

// ─── PARTICIPATION PILLAR ────────────────────────────────────

function computeParticipationMetrics(holders, allTrades, domeCandles14d) {
  const metrics = {};
  const fmt = (v, d) => v != null ? parseFloat(v.toFixed(d)) : null;

  // ── Parse holder data (DATA API — top 20 per side) ────────
  let yesPositions = [], noPositions = [];
  if (holders && Array.isArray(holders)) {
    for (const side of holders) {
      const sideHolders = side.holders && Array.isArray(side.holders) ? side.holders : [];
      const label = (side.outcome || side.token_id || '').toString().toLowerCase();
      const isYes = label.includes('yes') || label === '0' || label === holders[0]?.outcome;
      for (const h of sideHolders) {
        const amt = parseFloat(h.amount || 0);
        if (isYes || holders.indexOf(side) === 0) yesPositions.push(amt);
        else noPositions.push(amt);
      }
    }
  }
  const allPositions = [...yesPositions, ...noPositions];
  const sortedPositions = [...allPositions].sort((a, b) => b - a);
  const totalAmount = sortedPositions.reduce((a, b) => a + b, 0);

  // ── Parse trade data (Dome trades) ────────────────────────
  const uniqueWallets = new Set();
  const yesWallets = new Set(), noWallets = new Set();
  const tradeSizes = [];
  const largeTrades = []; // trades > $500
  if (allTrades && allTrades.length > 0) {
    for (const trade of allTrades) {
      const wallet = trade.user || trade.proxyWallet;
      const price = parseFloat(trade.price || 0);
      const shares = parseFloat(trade.shares_normalized || trade.size || 0);
      const dollarValue = shares * price;
      const side = (trade.side || '').toUpperCase();
      const token = (trade.token_label || '').toLowerCase();

      if (wallet) {
        uniqueWallets.add(wallet);
        if (token === 'yes') yesWallets.add(wallet);
        else if (token === 'no') noWallets.add(wallet);
      }
      if (dollarValue > 0) tradeSizes.push(dollarValue);
      if (dollarValue >= 500) {
        // Determine bullish or bearish
        // BUY YES or SELL NO = bullish. SELL YES or BUY NO = bearish.
        const isBullish = (side === 'BUY' && token === 'yes') || (side === 'SELL' && token === 'no');
        largeTrades.push({ value: dollarValue, bullish: isBullish });
      }
    }
  }

  // ── 1. Unique Wallets (7d) ────────────────────────────────
  const walletCount = uniqueWallets.size;
  metrics.uniqueWallets = {
    value: walletCount,
    unit: 'wallets',
    score: scoreBetween(walletCount, 10, 1000),
    signal: walletCount === 0 ? 'unavailable' : walletCount > 200 ? 'good' : walletCount > 50 ? 'neutral' : 'bad',
    context: walletCount === 0 ? null : walletCount + ' wallets traded in last 7 days',
  };

  // ── 2. Top 5 Concentration ────────────────────────────────
  let top5Pct = null;
  if (totalAmount > 0 && sortedPositions.length >= 5) {
    top5Pct = (sortedPositions.slice(0, 5).reduce((a, b) => a + b, 0) / totalAmount) * 100;
  }
  metrics.top5Concentration = {
    value: fmt(top5Pct, 1),
    unit: '%',
    score: top5Pct != null ? (11 - scoreBetween(top5Pct, 20, 90)) : null,
    signal: top5Pct == null ? 'unavailable' : top5Pct < 30 ? 'good' : top5Pct < 60 ? 'neutral' : 'bad',
    context: top5Pct == null ? null
      : top5Pct < 30 ? 'Well distributed'
      : top5Pct > 60 ? 'Top 5 wallets control ' + fmt(top5Pct, 0) + '% — whale-dominated'
      : 'Moderate concentration',
  };

  // ── 3. Whale Exit Risk (largest position / daily volume) ──
  const largestPos = sortedPositions.length > 0 ? sortedPositions[0] : null;
  let whaleExitDays = null;
  // Get volume24h from Dome candles
  let vol24h = null;
  if (domeCandles14d && Array.isArray(domeCandles14d) && domeCandles14d.length > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const oneDayAgo = nowSec - 86400;
    let vol = 0;
    for (const candle of domeCandles14d) {
      const ts = candle.end_period_ts || 0;
      if (ts >= oneDayAgo) {
        const meanPrice = parseFloat(candle.price?.mean_dollars || 0);
        const shares = parseFloat(candle.volume || 0);
        vol += (shares / 1000000) * meanPrice;
      }
    }
    if (vol > 0) vol24h = vol;
  }
  if (largestPos != null && vol24h != null && vol24h > 0) {
    whaleExitDays = largestPos / vol24h;
  }
  metrics.whaleExitRisk = {
    value: fmt(whaleExitDays, 1),
    unit: 'days to unwind',
    score: whaleExitDays != null ? (11 - scoreBetween(whaleExitDays, 1, 30)) : null,
    signal: whaleExitDays == null ? 'unavailable' : whaleExitDays < 2 ? 'good' : whaleExitDays < 7 ? 'neutral' : 'bad',
    context: whaleExitDays == null ? null
      : whaleExitDays < 1 ? 'Largest holder ($' + Math.round(largestPos).toLocaleString() + ') could exit in under a day'
      : whaleExitDays < 3 ? 'Largest holder ($' + Math.round(largestPos).toLocaleString() + ') needs ' + fmt(whaleExitDays, 1) + ' days to exit'
      : whaleExitDays < 10 ? 'Largest holder ($' + Math.round(largestPos).toLocaleString() + ') would take ' + fmt(whaleExitDays, 0) + ' days to exit — exit would move the price'
      : 'Largest holder ($' + Math.round(largestPos).toLocaleString() + ') trapped — ' + fmt(whaleExitDays, 0) + ' days to unwind at current volume',
  };

  // ── 4. OI Trend 7d (from Dome candles open_interest) ──────
  let oiTrend7d = null;
  if (domeCandles14d && Array.isArray(domeCandles14d) && domeCandles14d.length >= 2) {
    const nowSec = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = nowSec - 86400 * 7;

    // Find the candle closest to 7 days ago and the most recent candle
    let recentOI = null, priorOI = null;
    let recentTs = 0, priorDist = Infinity;

    for (const candle of domeCandles14d) {
      const ts = candle.end_period_ts || 0;
      const oi = parseFloat(candle.open_interest || 0);
      if (oi <= 0) continue;

      if (ts > recentTs) { recentTs = ts; recentOI = oi; }

      const dist = Math.abs(ts - sevenDaysAgo);
      if (dist < priorDist) { priorDist = dist; priorOI = oi; }
    }

    if (recentOI != null && priorOI != null && priorOI > 0) {
      oiTrend7d = ((recentOI - priorOI) / priorOI) * 100;
    }
  }
  const cappedOiTrend = oiTrend7d != null ? Math.max(-200, Math.min(200, oiTrend7d)) : null;
  const oiTrendCapped = oiTrend7d != null && Math.abs(oiTrend7d) > 200;
  metrics.oiTrend7d = {
    value: fmt(cappedOiTrend, 1),
    unit: '%',
    score: oiTrend7d != null ? scoreBetween(oiTrend7d, -30, 50) : null,
    signal: oiTrend7d == null ? 'unavailable' : oiTrend7d > 10 ? 'good' : oiTrend7d > -10 ? 'neutral' : 'bad',
    context: oiTrend7d == null ? null
      : oiTrendCapped && oiTrend7d > 0 ? 'New market — OI growing rapidly'
      : oiTrendCapped && oiTrend7d < 0 ? 'Severe outflow — positions closing fast'
      : oiTrend7d > 20 ? 'Money flowing in — growing conviction'
      : oiTrend7d > 0 ? 'Stable interest'
      : oiTrend7d > -20 ? 'Slight outflow'
      : 'Money leaving — positions being closed',
  };

  // ── 5. Side Balance (YES vs NO wallet count) ──────────────
  const yesCount = yesWallets.size, noCount = noWallets.size;
  const totalSided = yesCount + noCount;
  let sideBalance = null;
  if (totalSided > 0) {
    sideBalance = yesCount / totalSided; // 0.5 = perfectly balanced
  }
  metrics.sideBalance = {
    value: sideBalance != null ? { yes: yesCount, no: noCount, ratio: fmt(sideBalance, 3) } : null,
    unit: 'ratio',
    score: sideBalance != null ? scoreCloseTo(sideBalance, 0.5, 0.5) : null,
    signal: sideBalance == null ? 'unavailable' : Math.abs(sideBalance - 0.5) < 0.15 ? 'good' : Math.abs(sideBalance - 0.5) < 0.3 ? 'neutral' : 'bad',
    context: sideBalance == null ? null
      : Math.abs(sideBalance - 0.5) < 0.1 ? yesCount + ' YES / ' + noCount + ' NO — evenly split'
      : sideBalance > 0.65 ? yesCount + ' YES / ' + noCount + ' NO — YES side crowded'
      : sideBalance < 0.35 ? yesCount + ' YES / ' + noCount + ' NO — NO side crowded'
      : yesCount + ' YES / ' + noCount + ' NO',
  };

  // ── 6. Smart Money Direction (large trades > $500) ────────
  let smartMoneyDirection = null;
  let smartMoneyLabel = null;
  if (largeTrades.length >= 3) {
    const bullishValue = largeTrades.filter(t => t.bullish).reduce((s, t) => s + t.value, 0);
    const bearishValue = largeTrades.filter(t => !t.bullish).reduce((s, t) => s + t.value, 0);
    const totalLargeValue = bullishValue + bearishValue;
    if (totalLargeValue > 0) {
      smartMoneyDirection = ((bullishValue - bearishValue) / totalLargeValue); // -1 to +1
      smartMoneyLabel = smartMoneyDirection > 0.2 ? 'Bullish' : smartMoneyDirection < -0.2 ? 'Bearish' : 'Mixed';
    }
  }
  metrics.smartMoneyDirection = {
    value: smartMoneyLabel,
    unit: 'direction',
    score: null, // informational — not scored
    signal: smartMoneyDirection == null ? 'unavailable' : 'neutral',
    context: smartMoneyDirection == null ? null
      : largeTrades.length + ' large trades (>$500) — net ' + smartMoneyLabel.toLowerCase()
        + ' ($' + Math.round(largeTrades.filter(t => t.bullish).reduce((s, t) => s + t.value, 0)).toLocaleString() + ' bullish'
        + ' vs $' + Math.round(largeTrades.filter(t => !t.bullish).reduce((s, t) => s + t.value, 0)).toLocaleString() + ' bearish)',
  };

  // ── 7. Per-Side Concentration ─────────────────────────────
  const yesSorted = [...yesPositions].sort((a, b) => b - a);
  const noSorted = [...noPositions].sort((a, b) => b - a);
  const yesTotal = yesSorted.reduce((a, b) => a + b, 0);
  const noTotal = noSorted.reduce((a, b) => a + b, 0);
  let yesTop5Pct = null, noTop5Pct = null;
  if (yesTotal > 0 && yesSorted.length >= 5) yesTop5Pct = (yesSorted.slice(0, 5).reduce((a, b) => a + b, 0) / yesTotal) * 100;
  if (noTotal > 0 && noSorted.length >= 5) noTop5Pct = (noSorted.slice(0, 5).reduce((a, b) => a + b, 0) / noTotal) * 100;

  // Score the worse side — the more concentrated side is the risk
  const worstConc = [yesTop5Pct, noTop5Pct].filter(v => v != null);
  const maxConc = worstConc.length > 0 ? Math.max(...worstConc) : null;
  metrics.perSideConcentration = {
    value: yesTop5Pct != null || noTop5Pct != null ? { yes: fmt(yesTop5Pct, 1), no: fmt(noTop5Pct, 1) } : null,
    unit: '%',
    score: maxConc != null ? (11 - scoreBetween(maxConc, 30, 95)) : null,
    signal: maxConc == null ? 'unavailable' : maxConc < 50 ? 'good' : maxConc < 75 ? 'neutral' : 'bad',
    context: yesTop5Pct == null && noTop5Pct == null ? null
      : 'YES top 5: ' + (yesTop5Pct != null ? fmt(yesTop5Pct, 0) + '%' : 'N/A')
        + ' · NO top 5: ' + (noTop5Pct != null ? fmt(noTop5Pct, 0) + '%' : 'N/A'),
  };

  // ── 8. Median Trade Size ──────────────────────────────────
  let medianTrade = null;
  if (tradeSizes.length > 0) {
    const st = [...tradeSizes].sort((a, b) => a - b);
    const mid = Math.floor(st.length / 2);
    medianTrade = st.length % 2 !== 0 ? st[mid] : (st[mid-1] + st[mid]) / 2;
  }
  metrics.medianTradeSize = {
    value: fmt(medianTrade, 2),
    unit: 'USD',
    score: null, // informational
    signal: medianTrade == null ? 'unavailable' : 'neutral',
    context: medianTrade == null ? null
      : medianTrade < 20 ? 'Typical trade: $' + fmt(medianTrade, 2) + ' — mostly retail'
      : medianTrade < 200 ? 'Typical trade: $' + fmt(medianTrade, 2) + ' — mixed crowd'
      : 'Typical trade: $' + fmt(medianTrade, 2) + ' — serious traders',
  };

  // ── PILLAR SCORE ──────────────────────────────────────────
  const scorable = ['uniqueWallets', 'top5Concentration', 'whaleExitRisk', 'oiTrend7d', 'sideBalance', 'perSideConcentration'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  const pillarScore = scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null;

  // ── WARNINGS ──────────────────────────────────────────────
  const warnings = [];

  const isWhaleTrapped = whaleExitDays != null && whaleExitDays > 10;
  const isHighConc = top5Pct != null && top5Pct > 60;
  const isOiDeclining = oiTrend7d != null && oiTrend7d < -20;
  const isLopsided = sideBalance != null && (sideBalance > 0.8 || sideBalance < 0.2);
  const isOneSideWhale = maxConc != null && maxConc > 80;
  const isLowParticipation = walletCount > 0 && walletCount < 30;

  // Combined warnings
  if (isWhaleTrapped && isOiDeclining) {
    warnings.push({ type: 'danger', text: 'Whale trapped in a shrinking market — largest position needs ' + fmt(whaleExitDays, 0) + ' days to unwind and open interest is down ' + fmt(Math.abs(oiTrend7d), 0) + '%. Their exit will crash the price.' });
  } else if (isHighConc && isOneSideWhale) {
    warnings.push({ type: 'danger', text: 'Whale-dominated market — top 5 hold ' + fmt(top5Pct, 0) + '% of OI and one side is ' + fmt(maxConc, 0) + '% concentrated. Price reflects a few wallets, not the crowd.' });
  } else if (isLopsided && isOiDeclining) {
    warnings.push({ type: 'warning', text: 'One-sided and shrinking — ' + (sideBalance > 0.5 ? yesCount + ' YES' : noCount + ' NO') + ' traders vs ' + (sideBalance > 0.5 ? noCount + ' NO' : yesCount + ' YES') + ' and money is flowing out.' });
  }

  // Single warnings
  if (warnings.length === 0) {
    if (isWhaleTrapped) {
      warnings.push({ type: 'warning', text: 'Whale exit risk — largest position ($' + Math.round(largestPos).toLocaleString() + ') would take ' + fmt(whaleExitDays, 0) + ' days to unwind. If they sell, expect price disruption.' });
    } else if (isHighConc) {
      warnings.push({ type: 'warning', text: 'Top 5 wallets control ' + fmt(top5Pct, 0) + '% of open interest. This price may reflect a few large players, not broad consensus.' });
    } else if (isOiDeclining) {
      warnings.push({ type: 'warning', text: 'Open interest down ' + fmt(Math.abs(oiTrend7d), 0) + '% this week — money is leaving this market.' });
    } else if (isLopsided) {
      warnings.push({ type: 'warning', text: 'Lopsided participation — ' + yesCount + ' YES wallets vs ' + noCount + ' NO wallets. The minority side may be illiquid.' });
    } else if (isOneSideWhale) {
      warnings.push({ type: 'warning', text: 'One side is whale-dominated — top 5 hold ' + fmt(maxConc, 0) + '%. You may be trading against concentrated, informed capital.' });
    } else if (isLowParticipation) {
      warnings.push({ type: 'warning', text: 'Low participation — only ' + walletCount + ' unique wallets in last 7 days.' });
    }
  }

  // Positive
  if (warnings.length === 0 && pillarScore != null && pillarScore >= 7) {
    warnings.push({ type: 'info', text: 'Healthy participation — ' + walletCount + ' wallets, well-distributed positions, balanced sides.' });
  }

  const warning = warnings.length > 0 ? warnings[0] : null;

  return {
    score: pillarScore,
    status: pillarScore >= 7 ? 'pass' : pillarScore >= 4 ? 'caution' : pillarScore != null ? 'fail' : 'unavailable',
    confidence: scores.length >= 4 ? 'high' : scores.length >= 2 ? 'medium' : 'low',
    metricsComputed: scores.length,
    metricsTotal: 8,
    warning,
    warnings,
    metrics,
  };
}

// ─── RESOLUTION PILLAR ───────────────────────────────────────

function computeResolutionMetrics(gammaMarket, openInterest, holders) {
  const metrics = {};
  const fmt = (v, d) => v != null ? parseFloat(v.toFixed(d)) : null;
  const desc = gammaMarket.description || '';

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

  const descLength = desc.length;
  metrics.descriptionLength = { value: descLength, unit: 'chars', score: scoreBetween(descLength, 50, 1000), signal: descLength > 500 ? 'good' : descLength > 200 ? 'neutral' : 'bad', context: descLength > 500 ? 'Thorough description' : 'Brief description' };

  const resolutionKeywords = ['resolve', 'resolution', 'will resolve to', 'yes if', 'no if', 'otherwise', 'source', 'oracle', 'official', 'deadline', 'by', 'before', 'after', 'criteria', 'qualify', 'does not qualify', 'consensus', 'reporting', 'announced', 'defined as', 'means', 'specifically', 'edge case', 'exception', 'excluding', 'including', 'AM ET', 'PM ET', 'UTC', 'EST'];
  const lowerDesc = desc.toLowerCase();
  let keywordHits = 0;
  for (const kw of resolutionKeywords) { if (lowerDesc.includes(kw.toLowerCase())) keywordHits++; }
  metrics.contractDetailScore = { value: keywordHits, unit: `of ${resolutionKeywords.length} terms`, score: scoreBetween(keywordHits, 2, 15), signal: keywordHits >= 10 ? 'good' : keywordHits >= 5 ? 'neutral' : 'bad', context: keywordHits >= 10 ? 'Detailed contract' : keywordHits >= 5 ? 'Moderate detail' : 'Vague contract', _note: 'Keyword-based. Claude API analysis coming Phase 2.' };

  const hasEndDate = gammaMarket.endDate != null;
  metrics.hasEndDate = { value: hasEndDate, unit: 'boolean', score: hasEndDate ? 8 : 3, signal: hasEndDate ? 'good' : 'warn', context: hasEndDate ? 'Defined timeline' : 'No end date — open-ended risk' };

  const outcomes = gammaMarket.outcomes ? JSON.parse(gammaMarket.outcomes) : [];
  const resType = outcomes.length <= 2 ? 'binary' : 'multi-outcome';
  metrics.resolutionType = { value: resType, unit: 'type', score: resType === 'binary' ? 8 : 6, signal: 'neutral', context: resType === 'binary' ? 'Simple Yes/No' : `${outcomes.length} outcomes` };

  let oiValue = null;
  if (openInterest && Array.isArray(openInterest) && openInterest.length > 0) oiValue = openInterest[0].value != null ? parseFloat(openInterest[0].value) : null;
  metrics.openInterest = { value: fmt(oiValue, 2), unit: 'USD', score: oiValue != null ? scoreBetween(oiValue, 5000, 2000000) : null, signal: oiValue == null ? 'unavailable' : oiValue > 500000 ? 'good' : oiValue > 50000 ? 'neutral' : 'bad', context: oiValue != null ? `$${Math.round(oiValue).toLocaleString()} at stake` : null };

  const disputeBond = 750;
  let oiBondRatio = null;
  if (oiValue != null) oiBondRatio = oiValue / disputeBond;
  metrics.oiDisputeRatio = { value: fmt(oiBondRatio, 0), unit: '×', score: oiBondRatio != null ? scoreBetween(oiBondRatio, 10, 2000) : null, signal: oiBondRatio == null ? 'unavailable' : oiBondRatio > 500 ? 'good' : oiBondRatio > 50 ? 'neutral' : 'bad', context: oiBondRatio != null ? (oiBondRatio > 50 ? 'Dispute economically viable' : 'Low incentive to dispute') : null };

  let resAllPositions = [];
  if (holders && Array.isArray(holders)) {
    for (const side of holders) {
      if (side.holders && Array.isArray(side.holders)) {
        for (const h of side.holders) resAllPositions.push(parseFloat(h.amount || 0));
      }
    }
  }
  const largestPos = resAllPositions.length > 0 ? Math.max(...resAllPositions) : null;
  metrics.largestPosition = { value: fmt(largestPos, 2), unit: 'USD', score: null, signal: largestPos == null ? 'unavailable' : 'neutral', context: largestPos != null ? `$${Math.round(largestPos).toLocaleString()} — strong incentive for correct resolution` : null };

  const endDate = gammaMarket.endDate;
  let daysLeft = null;
  if (endDate) { daysLeft = Math.floor((new Date(endDate) - new Date()) / (1000 * 60 * 60 * 24)); if (daysLeft < 0) daysLeft = 0; }
  metrics.resolutionTimeRisk = { value: daysLeft, unit: 'days remaining', score: daysLeft != null ? scoreBetween(daysLeft, 1, 180) : null, signal: daysLeft == null ? 'unavailable' : daysLeft > 60 ? 'good' : daysLeft > 14 ? 'neutral' : 'warn', context: daysLeft == null ? null : daysLeft > 60 ? 'No time pressure' : daysLeft > 14 ? 'Adequate time' : 'Resolution approaching' };

  const scorable = ['resolutionSource', 'descriptionLength', 'contractDetailScore', 'hasEndDate', 'resolutionType', 'openInterest', 'oiDisputeRatio', 'resolutionTimeRisk'];
  const scores = scorable.map(k => metrics[k]?.score).filter(s => s != null);
  const pillarScore = scores.length > 0 ? parseFloat((scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1)) : null;

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

    const DOME_API_KEY = process.env.DOME_API_KEY;
    const startTime = Date.now();

    // 7 parallel calls: CLOB (3) + DATA API (2) + Dome (2)
    const results = await Promise.allSettled([
      fetch(`https://clob.polymarket.com/book?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),      // 0
      fetch(`https://clob.polymarket.com/spread?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),    // 1
      fetch(`https://clob.polymarket.com/midpoint?token_id=${primaryTokenId}`).then(r => r.ok ? r.json() : null),  // 2
      fetch(`https://data-api.polymarket.com/holders?market=${conditionId}`).then(r => r.ok ? r.json() : null),    // 3
      fetch(`https://data-api.polymarket.com/oi?market=${conditionId}`).then(r => r.ok ? r.json() : null),         // 4
      fetchDomeCandles(conditionId, 14, 1440, DOME_API_KEY),  // 5
      fetchDomeTrades(conditionId, 7, DOME_API_KEY, 3),       // 6
    ]);

    const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const get = (i) => results[i].status === 'fulfilled' ? results[i].value : null;

    const orderbook = get(0), spread = get(1), midpoint = get(2);
    const holders = get(3), openInterest = get(4);
    const domeCandles14d = get(5);
    const domeTrades = get(6);

    const allTrades = Array.isArray(domeTrades) ? domeTrades : [];

    // Compute 3 pillars
    const liquidity = computeLiquidityMetrics(orderbook, spread, midpoint, domeCandles14d, domeTrades);
    const participation = computeParticipationMetrics(holders, allTrades, domeCandles14d);
    const resolution = computeResolutionMetrics(market, openInterest, holders);

    const blockingIssues = [];
    const pillarEntries = { liquidity, participation, resolution };
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

      scores: { liquidity: liquidity.score, participation: participation.score, resolution: resolution.score },
      pillars: { liquidity, participation, resolution },

      rawData: {
        orderbook: orderbook ? { bids: orderbook.bids ? orderbook.bids.length : 0, asks: orderbook.asks ? orderbook.asks.length : 0, bestBid: orderbook.bids?.[0] || null, bestAsk: orderbook.asks?.[0] || null } : null,
        spread: spread || null,
        midpoint: midpoint || null,
        holders: holders ? { sides: Array.isArray(holders) ? holders.length : 0, totalTopHolders: Array.isArray(holders) ? holders.reduce((sum, s) => sum + (s.holders ? s.holders.length : 0), 0) : 0 } : null,
        openInterest: openInterest || null,
        dome: { candles: Array.isArray(domeCandles14d) ? domeCandles14d.length : 0, trades: allTrades.length },
      },
    });

  } catch (err) {
    console.error('Score endpoint error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
};
