const log = require('../core/log');

/**
 * Gamma API client — generates presentations from structured text.
 * Uses the workspace default theme (configured in Gamma settings).
 *
 * API docs: https://developers.gamma.app
 */
class GammaClient {
  constructor() {
    this.apiKey = process.env.GAMMA_API_KEY || '';
    this.baseUrl = 'https://public-api.gamma.app/v1.0';
  }

  isConfigured() {
    return !!this.apiKey;
  }

  async _request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'X-API-KEY': this.apiKey,
      'Accept': 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gamma ${method} ${path} → ${res.status}: ${text}`);
    }

    return res.json();
  }

  /**
   * Generate a presentation from structured markdown.
   * Uses \n---\n as slide boundaries.
   * Returns the generation ID for polling.
   */
  async generate(inputText, opts = {}) {
    const body = {
      inputText,
      textMode: opts.textMode || 'preserve',
      cardSplit: 'inputTextBreaks',
    };

    const data = await this._request('POST', '/generations', body);
    log.info(`Gamma: generation started (id: ${data.generationId})`);
    return data.generationId;
  }

  /**
   * Poll a generation until it completes or fails.
   * Returns { gammaUrl, gammaId, credits } on success.
   */
  async pollUntilDone(generationId, { maxWaitMs = 120000, intervalMs = 5000 } = {}) {
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const data = await this._request('GET', `/generations/${generationId}`);

      if (data.status === 'completed') {
        log.info(`Gamma: generation completed → ${data.gammaUrl} (${data.credits?.deducted || '?'} credits used)`);
        return {
          gammaUrl: data.gammaUrl,
          gammaId: data.gammaId,
          credits: data.credits,
        };
      }

      if (data.status === 'failed') {
        throw new Error(`Gamma generation failed: ${data.error || 'unknown'}`);
      }

      // Still pending — wait and retry
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Gamma generation timed out after ${maxWaitMs / 1000}s`);
  }

  /**
   * Generate a presentation and wait for it to complete.
   * Convenience wrapper around generate() + pollUntilDone().
   */
  async generateAndWait(inputText, opts = {}) {
    const generationId = await this.generate(inputText, opts);
    return this.pollUntilDone(generationId);
  }
}

module.exports = GammaClient;
