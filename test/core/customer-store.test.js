import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';

const CustomerStore = require('../../src/core/customer-store');

describe('CustomerStore', () => {
  let store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new CustomerStore();
    // Clear any state loaded from disk
    store.customers.clear();
    store.environments.clear();
    store.deployments = [];
    store.mobile.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('customers', () => {
    it('upserts a new customer', () => {
      const c = store.upsertCustomer({ id: 'ck', name: 'Comfort Keepers', active: true });
      expect(c.id).toBe('ck');
      expect(c.createdAt).toBeTruthy();
    });

    it('updates existing customer preserving manual fields', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', active: true, notes: 'manual note' });
      const updated = store.upsertCustomer({ id: 'ck', name: 'CK Updated', active: true, notes: null });
      expect(updated.name).toBe('CK Updated');
      expect(updated.notes).toBe('manual note'); // preserved
    });

    it('lists customers sorted by id', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', active: true });
      store.upsertCustomer({ id: 'bayada', name: 'Bayada', active: true });
      store.upsertCustomer({ id: 'tribute', name: 'Tribute', active: false });

      const list = store.listCustomers();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe('bayada');
    });

    it('filters customers by active', () => {
      store.upsertCustomer({ id: 'ck', active: true });
      store.upsertCustomer({ id: 'tribute', active: false });

      expect(store.listCustomers({ active: true })).toHaveLength(1);
      expect(store.listCustomers({ active: false })).toHaveLength(1);
    });

    it('getCustomer returns null for unknown id', () => {
      expect(store.getCustomer('unknown')).toBeNull();
    });

    it('emits customer:updated on upsert', () => {
      let emitted = null;
      store.on('customer:updated', (c) => { emitted = c; });
      store.upsertCustomer({ id: 'ck', name: 'CK' });
      expect(emitted).not.toBeNull();
      expect(emitted.id).toBe('ck');
    });
  });

  describe('environments', () => {
    it('upserts a new environment', () => {
      const env = store.upsertEnvironment({
        id: 'ck-615',
        customerId: 'ck',
        tier: 'production',
        name: 'CK Prod',
      });
      expect(env.id).toBe('ck-615');
      expect(env.createdAt).toBeTruthy();
    });

    it('preserves live state on re-upsert from scanner', () => {
      store.upsertEnvironment({
        id: 'ck-615',
        customerId: 'ck',
        currentVersion: '4.2.0',
        reachable: true,
        disabled: true,
        notes: 'maintenance',
      });

      const updated = store.upsertEnvironment({
        id: 'ck-615',
        customerId: 'ck',
        name: 'CK Prod Updated',
        currentVersion: null, // scanner doesn't know version
      });

      expect(updated.currentVersion).toBe('4.2.0'); // preserved
      expect(updated.disabled).toBe(true); // preserved
      expect(updated.notes).toBe('maintenance'); // preserved
      expect(updated.name).toBe('CK Prod Updated'); // updated
    });

    it('lists environments with filters', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck', tier: 'production' });
      store.upsertEnvironment({ id: 'ck-616', customerId: 'ck', tier: 'staging' });
      store.upsertEnvironment({ id: 'bayada-100', customerId: 'bayada', tier: 'production' });

      expect(store.listEnvironments()).toHaveLength(3);
      expect(store.listEnvironments({ customerId: 'ck' })).toHaveLength(2);
      expect(store.listEnvironments({ tier: 'production' })).toHaveLength(2);
    });

    it('getEnvironment returns null for unknown id', () => {
      expect(store.getEnvironment('unknown')).toBeNull();
    });
  });

  describe('updateLiveState', () => {
    it('updates version on successful poll', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck', currentVersion: '4.1.0' });
      store.updateLiveState('ck-615', { version: '4.2.0', branch: 'release/4.2.0', reachable: true });

      const env = store.getEnvironment('ck-615');
      expect(env.currentVersion).toBe('4.2.0');
      expect(env.reachable).toBe(true);
      expect(env.versionSetManually).toBe(false);
    });

    it('preserves version on failed poll', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck', currentVersion: '4.1.0' });
      store.updateLiveState('ck-615', { version: null, reachable: false, error: 'timeout' });

      const env = store.getEnvironment('ck-615');
      expect(env.currentVersion).toBe('4.1.0'); // preserved
      expect(env.reachable).toBe(false);
    });

    it('emits version change event', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck', currentVersion: '4.1.0' });

      let change = null;
      store.on('environment:version', (_, c) => { change = c; });

      store.updateLiveState('ck-615', { version: '4.2.0', reachable: true });
      expect(change).toEqual({ old: '4.1.0', new: '4.2.0' });
    });

    it('does not emit version change for same version', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck', currentVersion: '4.2.0' });

      let emitted = false;
      store.on('environment:version', () => { emitted = true; });

      store.updateLiveState('ck-615', { version: '4.2.0', reachable: true });
      expect(emitted).toBe(false);
    });

    it('returns null for unknown environment', () => {
      expect(store.updateLiveState('unknown', { version: '4.2.0', reachable: true })).toBeNull();
    });
  });

  describe('persistence', () => {
    it('uses atomic writes', () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

      store.upsertCustomer({ id: 'test-ck', name: 'CK' });
      writeSpy.mockClear();
      renameSpy.mockClear();

      store.flush();
      expect(writeSpy).toHaveBeenCalled();
      expect(renameSpy).toHaveBeenCalled();
      expect(writeSpy.mock.calls[0][0]).toMatch(/\.tmp$/);

      writeSpy.mockRestore();
      renameSpy.mockRestore();
    });

    it('flush saves immediately', () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

      store.upsertCustomer({ id: 'test-ck2' });
      writeSpy.mockClear();
      // Debounce hasn't fired yet
      store.flush();
      expect(writeSpy).toHaveBeenCalled();

      writeSpy.mockRestore();
      renameSpy.mockRestore();
    });
  });
});
