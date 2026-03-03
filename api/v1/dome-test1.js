module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const DOME_API_KEY = process.env.DOME_API_KEY;
  if (!DOME_API_KEY) return res.status(500).json({ error: 'DOME_API_KEY not set' });

  // Test condition_id: Fed lower bound 3.25% market
  const conditionId = '0x70d8f4e6079e98fd9a34a8f6ce00a7dd3a73a924c9d9fab0664d516f38c6f280';
  const nowSec = Math.floor(Date.now() / 1000);
  const fourteenDaysAgo = nowSec - 86400 * 14;

  try {
    const [candleRes, tradeRes] = await Promise.all([
      fetch(`https://api.domeapi.io/v1/polymarket/candlesticks/${conditionId}?start_time=${fourteenDaysAgo}&end_time=${nowSec}&interval=1440`, { headers: { 'x-api-key': DOME_API_KEY } }),
      fetch(`https://api.domeapi.io/v1/polymarket/orders?condition_id=${conditionId}&start_time=${fourteenDaysAgo}&end_time=${nowSec}&limit=5`, { headers: { 'x-api-key': DOME_API_KEY } }),
    ]);

    const candles = candleRes.ok ? await candleRes.json() : { error: candleRes.status };
    const trades = tradeRes.ok ? await tradeRes.json() : { error: tradeRes.status };

    return res.status(200).json({
      dome_key_set: true,
      candles_status: candleRes.status,
      candles_sample: candles,
      trades_status: tradeRes.status,
      trades_sample: trades,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
