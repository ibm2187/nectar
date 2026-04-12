#!/usr/bin/env node

/**
 * Stdio-to-HTTP bridge for Nectar's MCP server.
 *
 * Claude Code launches this as a stdio MCP server. It proxies all
 * MCP messages to Nectar's Streamable HTTP endpoint at /mcp.
 *
 * Usage in .mcp.json:
 *   "nectar": {
 *     "command": "node",
 *     "args": ["/Users/dev/dev/nectar/src/mcp/stdio-bridge.mjs"]
 *   }
 *
 * Optionally pass --url to override the default:
 *   "args": ["stdio-bridge.mjs", "--url", "https://nectar.example.com/mcp"]
 *
 * Pass --token to authenticate with the remote server:
 *   "args": ["stdio-bridge.mjs", "--url", "https://nectar.example.com/mcp", "--token", "nectar__xxx"]
 */

const NECTAR_URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:4000/mcp';

const AUTH_TOKEN = process.argv.includes('--token')
  ? process.argv[process.argv.indexOf('--token') + 1]
  : null;

let buffer = '';

process.stderr.write(`[nectar-bridge] Started. URL=${NECTAR_URL} token=${AUTH_TOKEN ? 'yes' : 'no'}\n`);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // MCP over stdio uses newline-delimited JSON
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      process.stderr.write(`[nectar-bridge] >> ${msg.method || msg.id || 'response'}\n`);
      forwardToHttp(msg);
    } catch {
      // Not valid JSON yet, skip
    }
  }
});

async function forwardToHttp(msg) {
  try {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;

    const res = await fetch(NECTAR_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
    });

    const contentType = res.headers.get('content-type') || '';

    if (!res.ok) {
      const text = await res.text();
      process.stderr.write(`[nectar-bridge] HTTP ${res.status}: ${text.slice(0, 200)}\n`);
      return;
    }
    process.stderr.write(`[nectar-bridge] << HTTP ${res.status} (${contentType})\n`);

    if (contentType.includes('text/event-stream')) {
      // SSE response — parse events and forward as JSON lines
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data) {
            process.stdout.write(data + '\n');
          }
        }
      }
    } else {
      // Regular JSON response
      const data = await res.text();
      if (data.trim()) {
        process.stdout.write(data.trim() + '\n');
      }
    }
  } catch (err) {
    process.stderr.write(`Nectar bridge error: ${err.message}\n`);
  }
}

process.stdin.on('end', () => process.exit(0));
