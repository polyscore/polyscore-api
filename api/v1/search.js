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

    // If it looks like a slug (hyphens, no spaces), try direct event lookup first
    const looksLikeSlug = /^[a-z0-9-]+$/.test(query) && query.includes('-');
    if (looksLikeSlug) {
      const eventRes = await fetch(`https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(query)}`);
      if (eventRes.ok) {
        const event = await eventRes.json();
        if (event && event.id) {
          const markets = (event.markets || [])
            .filter(m => m.active && !m.closed)
            .sort((a, b) => {
  const aNum = parseFloat(a.groupItemThreshold);
  const bNum = parseFloat(b.groupItemThreshold);
  const bothNumeric = !isNaN(aNum) && !isNaN(bNum);
  if (bothNumeric) return aNum - bNum;
  let aPrice = 0, bPrice = 0;
  try { aPrice = parseFloat(JSON.parse(a.outcomePrices || '[]')[0] || 0); } catch(e) {}
  try { bPrice = parseFloat(JSON.parse(b.outcomePrices || '[]')[0] || 0); } catch(e) {}
  return bPrice - aPrice;
})
            });
          return res.status(200).json({
            query: q,
            resultCount: 1,
            events: [{
              id: event.id, title: event.title, slug: event.slug,
              image: event.image || event.icon || null,
              description: event.description ? event.description.slice(0, 200) + '...' : null,
              active: event.active, closed: event.closed,
              volume: event.volume || null, liquidity: event.liquidity || null,
              startDate: event.startDate || null, endDate: event.endDate || null,
              marketCount: markets.length, markets,
            }],
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
      .map(event => {
        const markets = (event.markets || [])
          .filter(m => m.active && !m.closed)
          .sort((a, b) => {
  const aNum = parseFloat(a.groupItemThreshold);
  const bNum = parseFloat(b.groupItemThreshold);
  const bothNumeric = !isNaN(aNum) && !isNaN(bNum);
  if (bothNumeric) return aNum - bNum;
  let aPrice = 0, bPrice = 0;
  try { aPrice = parseFloat(JSON.parse(a.outcomePrices || '[]')[0] || 0); } catch(e) {}
  try { bPrice = parseFloat(JSON.parse(b.outcomePrices || '[]')[0] || 0); } catch(e) {}
  return bPrice - aPrice;
})
          });
        return {
          id: event.id, title: event.title, slug: event.slug,
          image: event.image || event.icon || null,
          description: event.description ? event.description.slice(0, 200) + '...' : null,
          active: event.active, closed: event.closed,
          volume: event.volume || null, liquidity: event.liquidity || null,
          startDate: event.startDate || null, endDate: event.endDate || null,
          marketCount: markets.length, markets,
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
