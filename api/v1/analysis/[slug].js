// /api/v1/analysis/[slug].js
// Progressive enhancement endpoint — Claude API analyses contract resolution risk
// Called separately from /score/ so the main endpoint stays fast

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only', status: 405 } });

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Provide a market slug.', status: 400 } });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'ANTHROPIC_API_KEY not configured.', status: 500 } });

  const marketSlug = slug.trim().toLowerCase();

  try {
    // Fetch market data from GAMMA
    const gammaRes = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`);
    if (!gammaRes.ok) throw new Error(`GAMMA API failed: ${gammaRes.status}`);
    const markets = await gammaRes.json();
    if (!markets || markets.length === 0) return res.status(404).json({ error: { code: 'MARKET_NOT_FOUND', message: `No market found with slug '${marketSlug}'`, status: 404 } });

    const market = markets[0];
    const description = market.description || '';
    const resolutionSource = market.resolutionSource || 'Not specified';
    const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No'];
    const endDate = market.endDate || 'No end date';
    const title = market.question || '';

    if (!description || description.length < 20) {
      return res.status(200).json({
        slug: marketSlug,
        analysis: null,
        reason: 'Description too short to analyse.',
      });
    }

    const startTime = Date.now();

    // Build the Claude prompt
    const systemPrompt = `You are a prediction market contract analyst. Your job is to evaluate resolution risk — the chance that a contract's outcome will be disputed or ambiguous.

You will receive a Polymarket contract and must return ONLY a JSON object (no markdown, no backticks, no preamble) with this exact structure:

{
  "ambiguityScore": <number 1-10, where 1 = perfectly clear, 10 = extremely ambiguous>,
  "edgeCases": [<array of 1-4 strings, each a specific realistic scenario that could cause dispute>],
  "sourceAssessment": "<one sentence evaluating whether the resolution source can definitively answer the question>",
  "summary": "<one sentence overall assessment of resolution risk for a trader>"
}

Scoring guidance for ambiguityScore:
- 1-2: Objective, verifiable outcome with authoritative source (e.g. "Will the Fed cut rates?" resolved by FOMC statement)
- 3-4: Clear criteria but minor edge cases possible (e.g. "Will X country strike Y?" with well-defined strike criteria)
- 5-6: Moderate ambiguity — key terms could be interpreted differently (e.g. "Will the regime fall?" — what counts as falling?)
- 7-8: Significant ambiguity — reasonable people would disagree on resolution in plausible scenarios
- 9-10: Highly subjective — no clear criteria, resolution depends on interpretation

For edgeCases, only list scenarios that are REALISTIC and could actually cause dispute. Don't list far-fetched hypotheticals.

For sourceAssessment, evaluate whether the named source (or "consensus of credible reporting") can provide a definitive yes/no answer to this specific question.

Return ONLY the JSON object. No other text.`;

    const userPrompt = `Analyse this Polymarket contract for resolution risk:

TITLE: ${title}

OUTCOMES: ${outcomes.join(', ')}

END DATE: ${endDate}

RESOLUTION SOURCE: ${resolutionSource}

CONTRACT DESCRIPTION:
${description}`;

    // Call Claude API
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      throw new Error(`Claude API failed: ${claudeRes.status} — ${errBody}`);
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Parse Claude's JSON response
    let analysis;
    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      analysis = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(200).json({
        slug: marketSlug,
        analysis: null,
        reason: 'Claude response could not be parsed.',
        raw: rawText,
      });
    }

    // Validate and clamp
    analysis.ambiguityScore = Math.max(1, Math.min(10, Math.round(analysis.ambiguityScore || 5)));
    if (!Array.isArray(analysis.edgeCases)) analysis.edgeCases = [];
    analysis.edgeCases = analysis.edgeCases.slice(0, 4);
    if (typeof analysis.sourceAssessment !== 'string') analysis.sourceAssessment = null;
    if (typeof analysis.summary !== 'string') analysis.summary = null;

    const analysisTime = ((Date.now() - startTime) / 1000).toFixed(2);

    return res.status(200).json({
      slug: marketSlug,
      analysisTime: parseFloat(analysisTime),
      model: 'claude-sonnet-4-5-20250929',
      analysis: {
        ambiguityScore: analysis.ambiguityScore,
        ambiguityLabel: analysis.ambiguityScore <= 2 ? 'Very clear'
          : analysis.ambiguityScore <= 4 ? 'Mostly clear'
          : analysis.ambiguityScore <= 6 ? 'Some ambiguity'
          : analysis.ambiguityScore <= 8 ? 'Significant ambiguity'
          : 'Highly subjective',
        edgeCases: analysis.edgeCases,
        sourceAssessment: analysis.sourceAssessment,
        summary: analysis.summary,
      },
      market: {
        title,
        slug: market.slug,
        conditionId: market.conditionId,
        outcomes,
        endDate,
        resolutionSource,
      },
    });

  } catch (err) {
    console.error('Analysis endpoint error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
};
