import { describe, it, expect, beforeEach, vi } from 'vitest';

const GitHubClient = require('../../src/integrations/github');

function makeClient() {
  process.env.GITHUB_TOKEN = 'test-token';
  return new GitHubClient({ github: { repo: 'mavencare/nectar' } });
}

describe('GitHubClient — attachment helpers', () => {
  let client;

  beforeEach(() => {
    client = makeClient();
  });

  describe('getRef', () => {
    it('returns null on 404 (status-based, not regex on message)', async () => {
      const err = Object.assign(new Error('whatever message'), { status: 404 });
      client._request = vi.fn().mockRejectedValue(err);
      const result = await client.getRef('heads/missing');
      expect(result).toBeNull();
    });

    it('rethrows non-404 errors', async () => {
      const err = Object.assign(new Error('boom'), { status: 500 });
      client._request = vi.fn().mockRejectedValue(err);
      await expect(client.getRef('heads/x')).rejects.toThrow('boom');
    });
  });

  describe('createBranch', () => {
    it('swallows 422 already-exists race and reports raceLost', async () => {
      const err = Object.assign(new Error('GitHub POST → 422'), {
        status: 422,
        responseBody: '{"message":"Reference already exists"}',
      });
      client._request = vi.fn().mockRejectedValue(err);
      const result = await client.createBranch('issue-attachments', 'abc123');
      expect(result).toEqual({ raceLost: true });
    });

    it('rethrows 422 with unrelated message', async () => {
      const err = Object.assign(new Error('GitHub POST → 422'), {
        status: 422,
        responseBody: '{"message":"Validation failed"}',
      });
      client._request = vi.fn().mockRejectedValue(err);
      await expect(client.createBranch('x', 'sha')).rejects.toThrow();
    });
  });

  describe('ensureBranch', () => {
    it('is a no-op when the branch already exists', async () => {
      client._request = vi.fn(async (method, path) => {
        if (method === 'GET' && path.endsWith('/git/ref/heads/issue-attachments')) {
          return { object: { sha: 'existing-sha' } };
        }
        throw new Error(`unexpected ${method} ${path}`);
      });
      const result = await client.ensureBranch('issue-attachments');
      expect(result).toEqual({ created: false });
    });

    it('creates the branch from the default branch HEAD when missing', async () => {
      const calls = [];
      client._request = vi.fn(async (method, path, body) => {
        calls.push({ method, path });
        if (method === 'GET' && path === '/repos/mavencare/nectar/git/ref/heads/issue-attachments') {
          throw Object.assign(new Error('404'), { status: 404 });
        }
        if (method === 'GET' && path === '/repos/mavencare/nectar') {
          return { default_branch: 'main' };
        }
        if (method === 'GET' && path === '/repos/mavencare/nectar/git/ref/heads/main') {
          return { object: { sha: 'main-sha' } };
        }
        if (method === 'POST' && path === '/repos/mavencare/nectar/git/refs') {
          expect(body).toEqual({ ref: 'refs/heads/issue-attachments', sha: 'main-sha' });
          return { ref: 'refs/heads/issue-attachments' };
        }
        throw new Error(`unexpected ${method} ${path}`);
      });
      const result = await client.ensureBranch('issue-attachments');
      expect(result).toEqual({ created: true });
      expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
        'GET /repos/mavencare/nectar/git/ref/heads/issue-attachments',
        'GET /repos/mavencare/nectar',
        'GET /repos/mavencare/nectar/git/ref/heads/main',
        'POST /repos/mavencare/nectar/git/refs',
      ]);
    });
  });

  describe('uploadContent', () => {
    it('sends a PUT with base64 content on the target branch', async () => {
      client._request = vi.fn(async () => ({ content: { download_url: 'https://raw/x' } }));
      const result = await client.uploadContent({
        path: 'uploads/2026/04/abc-x.png',
        contentBase64: 'AAA=',
        message: 'chore: upload',
        branch: 'issue-attachments',
      });
      expect(result.content.download_url).toBe('https://raw/x');
      expect(client._request).toHaveBeenCalledWith(
        'PUT',
        '/repos/mavencare/nectar/contents/uploads/2026/04/abc-x.png',
        { message: 'chore: upload', content: 'AAA=', branch: 'issue-attachments' },
      );
    });
  });
});
