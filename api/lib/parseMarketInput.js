function parseMarketInput(input) {
  if (!input || typeof input !== 'string') return null;

  const trimmed = input.trim();

  // If it looks like a condition ID (hex), pass through
  if (/^0x[a-fA-F0-9]{40,}$/.test(trimmed)) {
    return { type: 'conditionId', value: trimmed };
  }

  // If it's a URL, extract the slug
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes('polymarket.com')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return { type: 'slug', value: parts[parts.length - 1] };
      }
    }
  } catch {
    // Not a URL — treat as raw slug
  }

  // Treat as raw slug
  if (/^[a-z0-9-]+$/i.test(trimmed)) {
    return { type: 'slug', value: trimmed.toLowerCase() };
  }

  return null;
}

module.exports = { parseMarketInput };
