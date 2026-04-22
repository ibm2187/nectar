function safeParseArray(value, fallback) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : fallback;
  } catch { return fallback; }
}
module.exports = { safeParseArray };
