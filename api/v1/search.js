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
    let query = q;
    const urlMatch = q.match(/polymarket\.com\/(?:event|market)\/([a-z0-9-]+)/i);
    if (urlMatch) query = urlMatch[1].split('?')[0];

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
        active: m.active,
  closed: m.closed,
        outcomes,
        outcomePrices,
        volume: m.volume || null,
        liquidity: m.liquidity || null,
        startDate: m.startDate || null,
        endDate: m.endDate || null,
      };
    }

function sortMarkets(markets) {
      if (markets.length <= 1) return markets;
      var leadingNums = markets.map(function(m) {
        var title = (m.groupItemTitle || '').toString();
        var match = title.match(/^(\d+)/);
        return match ? parseFloat(match[1]) : null;
      });
      var allHaveLeadingNum = leadingNums.every(function(n) { return n !== null; });
      var uniqueNums = new Set(leadingNums.filter(function(n) { return n !== null; }));
      if (allHaveLeadingNum && uniqueNums.size > 1) {
        return markets.sort(function(a, b) {
          var aMatch = a.groupItemTitle.match(/^(\d+)/);
          var bMatch = b.groupItemTitle.match(/^(\d+)/);
          return parseFloat(aMatch[1]) - parseFloat(bMatch[1]);
        });
      }

      // Check for arrow groups (↓ cuts / ↑ hikes)
      var hasArrows = markets.some(function(m) {
        var t = (m.groupItemTitle || '').toString();
        return t.indexOf('↓') !== -1 || t.indexOf('↑') !== -1;
      });
      if (hasArrows) {
        var downs = markets.filter(function(m) { return (m.groupItemTitle || '').indexOf('↓') !== -1; });
        var ups = markets.filter(function(m) { return (m.groupItemTitle || '').indexOf('↑') !== -1; });
        var others = markets.filter(function(m) {
          var t = m.groupItemTitle || '';
          return t.indexOf('↓') === -1 && t.indexOf('↑') === -1;
        });
        var getRate = function(m) {
          var match = (m.groupItemTitle || '').match(/([\d.]+)%/);
          return match ? parseFloat(match[1]) : 0;
        };
        downs.sort(function(a, b) { return getRate(b) - getRate(a); });
        ups.sort(function(a, b) { return getRate(a) - getRate(b); });
        return downs.concat(ups).concat(others);
      }

      // Default: sort by YES price descending
      return markets.sort(function(a, b) {
        var aPrice = 0, bPrice = 0;
        var aRaw = a.outcomePrices;
        var bRaw = b.outcomePrices;
        try {
          if (typeof aRaw === 'string') aRaw = JSON.parse(aRaw);
          if (Array.isArray(aRaw)) aPrice = parseFloat(aRaw[0]) || 0;
        } catch(e) {}
        try {
          if (typeof bRaw === 'string') bRaw = JSON.parse(bRaw);
          if (Array.isArray(bRaw)) bPrice = parseFloat(bRaw[0]) || 0;
        } catch(e) {}
        return bPrice - aPrice;
      });
    }

    function formatEvent(event) {
      var activeMarkets = (event.markets || []).filter(function(m) { return m.active && !m.closed; });
      var sorted = sortMarkets(activeMarkets);
      var markets = sorted.map(formatMarket);
      return {
        id: event.id,
        active: m.active,
  closed: m.closed,
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

    var looksLikeSlug = /^[a-z0-9-]+$/.test(query) && query.includes('-');
    if (looksLikeSlug) {
      var eventRes = await fetch('https://gamma-api.polymarket.com/events/slug/' + encodeURIComponent(query));
      if (eventRes.ok) {
        var event = await eventRes.json();
        if (event && event.id && event.active && !event.closed) {
          return res.status(200).json({
            query: q,
            resultCount: 1,
            events: [formatEvent(event)],
          });
        }
      }
    }

    var gammaRes = await fetch(
      'https://gamma-api.polymarket.com/public-search?q=' + encodeURIComponent(query)
    );
    if (!gammaRes.ok) throw new Error('GAMMA search failed: ' + gammaRes.status);
    var data = await gammaRes.json();
    var events = (data.events || [])
      .filter(function(e) { return e.active && !e.closed; })
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
