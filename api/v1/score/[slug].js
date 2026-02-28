const path = require('path');
const { parseMarketInput } = require(path.join(process.cwd(), 'lib', 'parseMarketInput'));
const {
  fetchMarketBySlug,
  fetchAllMarketData,
} = require(path.join(process.cwd(), 'lib', 'polymarket'));

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only', status: 405 },
    });
  }

  const { slug } = req.query;

  // 1. Parse the input
  const parsed = parseMarketInput(slug);
  if (!parsed) {
    return res.status(400).json({
      error: {
        code: 'INVALID_INPUT',
        message:
          'Provide a valid Polymarket market slug or URL.',
        status: 400,
      },
    });
  }

  try {
    // 2. Fetch market metadata from GAMMA
    if (parsed.type !== 'slug') {
      return res.status(400).json({
        error: {
          code: 'CONDITION_ID_NOT_YET_SUPPORTED',
          message:
            'Condition ID lookup coming soon. Use the market slug or URL.',
          status: 400,
        },
      });
    }

    const gammaMarket = await fetchMarketBySlug(parsed.value);

    if (!gammaMarket) {
      return res.status(404).json({
        error: {
          code: 'MARKET_NOT_FOUND',
          message: `No market found with slug '${parsed.value}'`,
          status: 404,
        },
      });
    }

    // 3. Fetch all data in parallel
    const { data, errors, fetchTime, tokenIds } =
      await fetchAllMarketData(gammaMarket);

    // 4. Build response
    const outcomes = gammaMarket.outcomes
      ? JSON.parse(gammaMarket.outcomes)
      : ['Yes', 'No'];

    const response = {
      polyscore: null,
      polyscoreStatus:
        'Phase 0 — raw data only, scoring coming in Phase 1',
      fetchTime: parseFloat(fetchTime.toFixed(2)),

      market: {
        title: gammaMarket.question,
        slug: gammaMarket.slug,
        conditionId: gammaMarket.conditionId,
        status: gammaMarket.active
          ? gammaMarket.closed
            ? 'closed'
            : 'open'
          : 'inactive',
        image: gammaMarket.image,
        description: gammaMarket.description,
        resolutionSource: gammaMarket.resolutionSource || null,
        outcomes,
        tags: gammaMarket.tags ? JSON.parse(gammaMarket.tags) : [],
        startTime: gammaMarket.startDate || gammaMarket.createdAt,
        endTime: gammaMarket.endDate || null,
        volume: gammaMarket.volume || null,
        liquidity: gammaMarket.liquidity || null,
        tokenIds,
      },

      rawData: {
        orderbook: data.orderbook
          ? {
              bids: data.orderbook.bids
                ? data.orderbook.bids.length
                : 0,
              asks: data.orderbook.asks
                ? data.orderbook.asks.length
                : 0,
              bestBid: data.orderbook.bids?.[0] || null,
              bestAsk: data.orderbook.asks?.[0] || null,
            }
          : null,

        spread: data.spread || null,
        midpoint: data.midpoint || null,

        priceHistory: {
          daily30d: data.priceHistory30d
            ? {
                points: Array.isArray(data.priceHistory30d.history)
                  ? data.priceHistory30d.history.length
                  : Array.isArray(data.priceHistory30d)
                    ? data.priceHistory30d.length
                    : 0,
              }
            : null,
          hourly24h: data.priceHistory24h
            ? {
                points: Array.isArray(data.priceHistory24h.history)
                  ? data.priceHistory24h.history.length
                  : Array.isArray(data.priceHistory24h)
                    ? data.priceHistory24h.length
                    : 0,
              }
            : null,
        },

        trades: data.trades
          ? {
              count: Array.isArray(data.trades)
                ? data.trades.length
                : 0,
              latest: Array.isArray(data.trades)
                ? data.trades.slice(0, 3)
                : null,
            }
          : null,

        holders: data.holders || null,
        openInterest: data.openInterest || null,

        marketTrades: data.marketTrades
          ? {
              count: Array.isArray(data.marketTrades)
                ? data.marketTrades.length
                : 0,
            }
          : null,
      },

      apiErrors: errors,
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('Score endpoint error:', err);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: err.message || 'Something went wrong',
        status: 500,
      },
    });
  }
};
