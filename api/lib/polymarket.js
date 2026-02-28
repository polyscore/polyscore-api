const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const DATA_BASE = 'https://data-api.polymarket.com';

// ─── GAMMA API ───────────────────────────────────────────────

async function fetchMarketBySlug(slug) {
  const res = await fetch(
    `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`
  );
  if (!res.ok) throw new Error(`GAMMA /markets failed: ${res.status}`);
  const markets = await res.json();
  if (!markets || markets.length === 0) return null;
  return markets[0];
}

// ─── CLOB API ────────────────────────────────────────────────

async function fetchOrderbook(tokenId) {
  const res = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`CLOB /book failed: ${res.status}`);
  return res.json();
}

async function fetchSpread(tokenId) {
  const res = await fetch(`${CLOB_BASE}/spread?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`CLOB /spread failed: ${res.status}`);
  return res.json();
}

async function fetchMidpoint(tokenId) {
  const res = await fetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`CLOB /midpoint failed: ${res.status}`);
  return res.json();
}

async function fetchPriceHistory(tokenId, interval, fidelity) {
  const res = await fetch(
    `${CLOB_BASE}/prices-history?market=${tokenId}&interval=${interval}&fidelity=${fidelity}`
  );
  if (!res.ok) throw new Error(`CLOB /prices-history failed: ${res.status}`);
  return res.json();
}

async function fetchTrades(tokenId) {
  const res = await fetch(`${CLOB_BASE}/trades?market=${tokenId}`);
  if (!res.ok) throw new Error(`CLOB /trades failed: ${res.status}`);
  return res.json();
}

// ─── DATA API ────────────────────────────────────────────────

async function fetchHolders(conditionId) {
  const res = await fetch(`${DATA_BASE}/holders?market=${conditionId}`);
  if (!res.ok) throw new Error(`DATA /holders failed: ${res.status}`);
  return res.json();
}

async function fetchOpenInterest(conditionId) {
  const res = await fetch(
    `${DATA_BASE}/open-interest?market=${conditionId}`
  );
  if (!res.ok) throw new Error(`DATA /open-interest failed: ${res.status}`);
  return res.json();
}

async function fetchMarketTrades(conditionId) {
  const res = await fetch(`${DATA_BASE}/trades?market=${conditionId}`);
  if (!res.ok) throw new Error(`DATA /trades failed: ${res.status}`);
  return res.json();
}

// ─── PARALLEL FETCHER ────────────────────────────────────────

async function fetchAllMarketData(gammaMarket) {
  const clobTokenIds = gammaMarket.clobTokenIds
    ? JSON.parse(gammaMarket.clobTokenIds)
    : [];

  const conditionId = gammaMarket.conditionId;
  const primaryTokenId = clobTokenIds[0];
  const secondaryTokenId = clobTokenIds[1];

  if (!primaryTokenId) {
    throw new Error('No CLOB token IDs found for this market');
  }

  const startTime = Date.now();

  const results = await Promise.allSettled([
    fetchOrderbook(primaryTokenId),
    fetchSpread(primaryTokenId),
    fetchMidpoint(primaryTokenId),
    fetchPriceHistory(primaryTokenId, '1d', '30'),
    fetchPriceHistory(primaryTokenId, '1h', '24'),
    fetchTrades(primaryTokenId),
    fetchHolders(conditionId),
    fetchOpenInterest(conditionId),
    fetchMarketTrades(conditionId),
  ]);

  const fetchTime = (Date.now() - startTime) / 1000;

  const unpack = (r) => (r.status === 'fulfilled' ? r.value : null);
  const errorOf = (r) =>
    r.status === 'rejected' ? r.reason.message : null;

  const data = {
    orderbook: unpack(results[0]),
    spread: unpack(results[1]),
    midpoint: unpack(results[2]),
    priceHistory30d: unpack(results[3]),
    priceHistory24h: unpack(results[4]),
    trades: unpack(results[5]),
    holders: unpack(results[6]),
    openInterest: unpack(results[7]),
    marketTrades: unpack(results[8]),
  };

  const errors = Object.fromEntries(
    Object.entries({
      orderbook: errorOf(results[0]),
      spread: errorOf(results[1]),
      midpoint: errorOf(results[2]),
      priceHistory30d: errorOf(results[3]),
      priceHistory24h: errorOf(results[4]),
      trades: errorOf(results[5]),
      holders: errorOf(results[6]),
      openInterest: errorOf(results[7]),
      marketTrades: errorOf(results[8]),
    }).filter(([, v]) => v !== null)
  );

  return {
    data,
    errors: Object.keys(errors).length > 0 ? errors : null,
    fetchTime,
    tokenIds: { yes: primaryTokenId, no: secondaryTokenId || null },
  };
}

module.exports = {
  fetchMarketBySlug,
  fetchAllMarketData,
};
