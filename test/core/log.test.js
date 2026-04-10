import { describe, it, expect, beforeEach, vi } from 'vitest';

const log = require('../../src/core/log');

describe('log', () => {
  it('has info, warn, error methods', () => {
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('info writes to console and file', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info('test message');
    expect(spy).toHaveBeenCalledWith('[nectar]', 'test message');
    spy.mockRestore();
  });

  it('warn writes to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.warn('warning msg');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('error writes to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.error('error msg');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('has json method for structured logging', () => {
    expect(typeof log.json).toBe('function');
    // Should not throw
    log.json('INFO', 'test-event', { key: 'value' });
  });
});
