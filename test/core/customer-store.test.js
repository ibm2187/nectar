import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const CustomerStore = require('../../src/core/customer-store');
const { createTestDb } = require('../../src/core/db');

describe('CustomerStore', () => {
  let store;
  let db;

  beforeEach(() => {
    db = createTestDb();
    store = new CustomerStore({ db });
  });

  afterEach(() => {
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

    it('lists customers sorted by sortOrder then id', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', active: true, sortOrder: 2 });
      store.upsertCustomer({ id: 'bayada', name: 'Bayada', active: true, sortOrder: 1 });
      store.upsertCustomer({ id: 'tribute', name: 'Tribute', active: false, sortOrder: 3 });

      const list = store.listCustomers();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe('bayada');
      expect(list[1].id).toBe('ck');
      expect(list[2].id).toBe('tribute');
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

  describe('upsertCustomer — USER_EDITABLE_FIELDS guard', () => {
    it('preserves shortName when scanner re-upserts', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', shortName: 'CK', color: '#0054A6' });
      const updated = store.upsertCustomer({ id: 'ck', name: 'CK New', shortName: 'Overwrite' });
      expect(updated.shortName).toBe('CK'); // preserved
      expect(updated.name).toBe('CK New');  // non-editable, updated
    });

    it('preserves color when scanner re-upserts', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', color: '#0054A6' });
      const updated = store.upsertCustomer({ id: 'ck', name: 'CK', color: '#FFFFFF' });
      expect(updated.color).toBe('#0054A6'); // preserved
    });

    it('preserves hidden and sortOrder when scanner re-upserts', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', hidden: true, sortOrder: 5 });
      const updated = store.upsertCustomer({ id: 'ck', name: 'CK', hidden: false, sortOrder: 1 });
      expect(updated.hidden).toBe(true);  // preserved
      expect(updated.sortOrder).toBe(5);  // preserved
    });

    it('allows initial seeding of null editable fields', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK' }); // no shortName/color set
      const updated = store.upsertCustomer({ id: 'ck', name: 'CK', shortName: 'CK', color: '#0054A6' });
      expect(updated.shortName).toBe('CK');       // set because was null
      expect(updated.color).toBe('#0054A6');       // set because was null
    });
  });

  describe('updateCustomer', () => {
    it('merges partial changes without resetting others', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', shortName: 'CK', color: '#0054A6', sortOrder: 2 });
      const updated = store.updateCustomer('ck', { color: '#FF0000' });
      expect(updated.color).toBe('#FF0000');
      expect(updated.shortName).toBe('CK');    // untouched
      expect(updated.sortOrder).toBe(2);        // untouched
      expect(updated.name).toBe('CK');          // untouched
    });

    it('returns null for unknown customer', () => {
      expect(store.updateCustomer('nonexistent', { color: '#000' })).toBeNull();
    });

    it('persists to DB and survives reload', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', color: '#000000' });
      store.updateCustomer('ck', { color: '#FF0000', shortName: 'Comfort' });
      const fresh = new CustomerStore({ db });
      const c = fresh.getCustomer('ck');
      expect(c.color).toBe('#FF0000');
      expect(c.shortName).toBe('Comfort');
    });
  });

  describe('seedDisplayDefaults', () => {
    it('seeds shortName/color/sortOrder for customers without shortName', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK' });
      store.upsertCustomer({ id: 'bayada', name: 'Bayada' });
      store.seedDisplayDefaults();
      const ck = store.getCustomer('ck');
      const bayada = store.getCustomer('bayada');
      expect(ck.shortName).toBe('CK');
      expect(ck.color).toBe('#0054A6');
      expect(bayada.shortName).toBe('Bayada');
      expect(bayada.color).toBe('#E31A38');
    });

    it('skips customers that already have shortName', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', shortName: 'Custom Label', color: '#111111' });
      store.seedDisplayDefaults();
      const ck = store.getCustomer('ck');
      expect(ck.shortName).toBe('Custom Label'); // not overwritten
      expect(ck.color).toBe('#111111');            // not overwritten
    });

    it('assigns fallback color to unknown customers', () => {
      store.upsertCustomer({ id: 'newcustomer', name: 'New Corp' });
      store.seedDisplayDefaults();
      const c = store.getCustomer('newcustomer');
      expect(c.shortName).toBe('New Corp'); // falls back to name
      expect(c.color).toBe('#64748b');       // fallback gray
    });
  });

  describe('listVisibleCustomers', () => {
    it('excludes hidden customers', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', hidden: false });
      store.upsertCustomer({ id: 'haven', name: 'Haven', hidden: true });
      const visible = store.listVisibleCustomers();
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe('ck');
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

  describe('deployments', () => {
    // Each version change should produce a deployment row.
    it('records a deployment when version changes via poll', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck', currentVersion: '4.1.0' });
      store.updateLiveState('ck-615', { version: '4.2.0', branch: 'release/4.2.0', reachable: true });

      const deployments = store.listDeployments({ environmentId: 'ck-615' });
      expect(deployments).toHaveLength(1);
      expect(deployments[0].version).toBe('4.2.0');
      expect(deployments[0].previousVersion).toBe('4.1.0');
      expect(deployments[0].source).toBe('api-poll');
    });

    it('records manual-source deployments via setManualVersion', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck', currentVersion: '4.1.0' });
      store.setManualVersion('ck-615', { version: '4.2.0', setBy: 'nukul' });

      const deployments = store.listDeployments({ environmentId: 'ck-615' });
      expect(deployments).toHaveLength(1);
      expect(deployments[0].source).toBe('manual');
    });

    it('ends previous active deployment when a new one starts', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck', currentVersion: '4.1.0' });
      store.updateLiveState('ck-615', { version: '4.2.0', reachable: true });
      store.updateLiveState('ck-615', { version: '4.3.0', reachable: true });

      const active = store.listDeployments({ environmentId: 'ck-615', active: true });
      expect(active).toHaveLength(1);
      expect(active[0].version).toBe('4.3.0');

      const all = store.listDeployments({ environmentId: 'ck-615' });
      expect(all).toHaveLength(2);
      // The older one should have an endedAt
      expect(all.find(d => d.version === '4.2.0').endedAt).toBeTruthy();
    });

    it('filter by customerId', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck', currentVersion: '4.1.0' });
      store.upsertEnvironment({ id: 'bayada-100', customerId: 'bayada', currentVersion: '4.1.0' });
      store.updateLiveState('ck-615', { version: '4.2.0', reachable: true });
      store.updateLiveState('bayada-100', { version: '4.2.0', reachable: true });

      expect(store.listDeployments({ customerId: 'ck' })).toHaveLength(1);
      expect(store.listDeployments({ customerId: 'bayada' })).toHaveLength(1);
    });

    it('countDeployments respects filters', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck' });
      store.upsertEnvironment({ id: 'bayada-100', customerId: 'bayada' });
      store.updateLiveState('ck-615', { version: '4.2.0', reachable: true });
      store.updateLiveState('bayada-100', { version: '4.2.0', reachable: true });
      store.updateLiveState('ck-615', { version: '4.3.0', reachable: true });

      expect(store.countDeployments()).toBe(3);
      expect(store.countDeployments({ customerId: 'ck' })).toBe(2);
      expect(store.countDeployments({ active: true })).toBe(2);
    });

    it('supports pagination', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck' });
      for (let i = 0; i < 5; i++) {
        store.updateLiveState('ck-615', { version: `4.${i}.0`, reachable: true });
      }
      const page = store.listDeployments({ limit: 2 });
      expect(page).toHaveLength(2);
    });
  });

  describe('health / features / integrations / upgrades', () => {
    beforeEach(() => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck' });
    });

    it('updateHealth persists structured payload as JSON', () => {
      store.updateHealth('ck-615', {
        status: 'degraded',
        checks: { mongo: 'ok', redis: 'fail' },
        summary: { totalChecks: 2, passed: 1, failed: 1, degraded: 0, skipped: 0 },
        responseTimeMs: 120,
        checkedAt: '2026-04-15T00:00:00.000Z',
      });
      const env = store.getEnvironment('ck-615');
      expect(env.health.status).toBe('degraded');
      expect(env.health.checks.redis).toBe('fail');
    });

    it('updateFeatures stores the array', () => {
      store.updateFeatures('ck-615', [{ flag: 'foo', enabled: true }]);
      expect(store.getEnvironment('ck-615').features).toEqual([{ flag: 'foo', enabled: true }]);
    });

    it('updateIntegrations stores the array', () => {
      store.updateIntegrations('ck-615', [{ name: 'zoho', status: 'connected' }]);
      expect(store.getEnvironment('ck-615').integrations[0].name).toBe('zoho');
    });

    it('updateUpgrades stores the array', () => {
      store.updateUpgrades('ck-615', [{ version: '4.3.0', status: 'pending' }]);
      expect(store.getEnvironment('ck-615').upgrades[0].status).toBe('pending');
    });
  });

  describe('persistence', () => {
    it('customers and environments survive a reload from DB', () => {
      store.upsertCustomer({ id: 'ck', name: 'CK', active: true, hasFranchises: true });
      store.upsertEnvironment({
        id: 'ck-615',
        customerId: 'ck',
        tier: 'production',
        franchise: true,
        currentVersion: '4.2.0',
        reachable: true,
      });
      store.updateHealth('ck-615', { status: 'healthy', checks: {}, summary: {}, responseTimeMs: 50 });

      const store2 = new CustomerStore({ db });
      const c = store2.getCustomer('ck');
      expect(c.name).toBe('CK');
      expect(c.active).toBe(true);
      expect(c.hasFranchises).toBe(true);

      const env = store2.getEnvironment('ck-615');
      expect(env.currentVersion).toBe('4.2.0');
      expect(env.reachable).toBe(true);
      expect(env.franchise).toBe(true);
      expect(env.health.status).toBe('healthy');
    });

    it('deployments are not loaded into memory (queried on demand)', () => {
      store.upsertEnvironment({ id: 'ck-615', customerId: 'ck' });
      store.updateLiveState('ck-615', { version: '4.2.0', reachable: true });

      const store2 = new CustomerStore({ db });
      // The in-memory array is empty by design
      expect(store2.deployments).toEqual([]);
      // But the data is still queryable
      expect(store2.listDeployments({ environmentId: 'ck-615' })).toHaveLength(1);
    });

    it('flush is a no-op', () => {
      store.upsertCustomer({ id: 'test-ck', name: 'CK' });
      expect(() => store.flush()).not.toThrow();
    });
  });
});
