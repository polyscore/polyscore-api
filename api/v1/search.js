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
    // Extract slug from Polymarket URLs
    let query = q;
    const urlMatch = q.match(/polymarket\.com\/(?:event|market)\/([a-z0-9-]+)/i);
    if (urlMatch) query = urlMatch[1].split('?')[0];

    // Helper: format a raw market object
    function formatMarket(m) {
      let outcomes = [], outcomePrices = [];
      try { outcomes = JSON.parse(m.outcomes || '[]'); } catch(e) {}
      try { outcomePrices = JSON.parse(m.outcomePrices || '[]'); } catch(e) {}
      return {
        id: m.id,
        question: m.question,
        groupItemTitle: m.groupItemTitle || null,
        slug: m.slug,
        conditionId: m.conditionId,
        outcomes,
        outcomePrices,
        volume: m.volume || null,
        liquidity: m.liquidity || null,
        startDate: m.startDate || null,
        endDate: m.endDate || null,
      };
    }

    // Helper: sort markets — numeric by threshold, text by price desc
    function sortMarkets(markets) {
      return markets.sort((a, b) => {
        const aNum = parseFloat(a.groupItemThreshold);
        const bNum = parseFloat(b.groupItemThreshold);
        if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
        let aPrice = 0, bPrice = 0;
        try { aPrice = parseFloat(JSON.parse(a.outcomePrices || '[]')[0] || 0); } catch(e) {}
        try { bPrice = parseFloat(JSON.parse(b.outcomePrices || '[]')[0] || 0); } catch(e) {}
        return bPrice - aPrice;
      });
    }

    // Helper: format a raw event object
    function formatEvent(event) {
      const activeMarkets = (event.markets || []).filter(m => m.active && !m.closed);
      const sorted = sortMarkets(activeMarkets);
      const markets = sorted.map(formatMarket);
      return {
        id: event.id,
        title: event.title,
        slug: event.slug,
        image: event.image || event.icon || null,
        description: event.description ? event.description.slice(0, 200) + '...' : null,
        volume: event.volume || null,
        liquidity: event.liquidity || null,
        startDate: event.startDate || null,
        endDate: event.endDate || null,
        marketCount: markets.length,
        markets,
      };
    }

    // If it looks like a slug, try direct event lookup first
    const looksLikeSlug = /^[a-z0-9-]+$/.test(query) && query.includes('-');
    if (looksLikeSlug) {
      const eventRes = await fetch(`https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(query)}`);
      if (eventRes.ok) {
        const event = await eventRes.json();
        if (event && event.id && event.active && !event.closed) {
          return res.status(200).json({
            query: q,
            resultCount: 1,
            events: [formatEvent(event)],
          });
        }
      }
    }

    // Fallback: regular search
    const gammaRes = await fetch(
      `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(query)}`
    );
    if (!gammaRes.ok) throw new Error(`GAMMA search failed: ${gammaRes.status}`);
    const data = await gammaRes.json();
    const events = (data.events || [])
      .filter(e => e.active && !e.closed)
      .slice(0, 20)
      .map(formatEvent);

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
