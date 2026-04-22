/**
 * Feature flag aggregator — collects all DB feature flags across all
 * production environments and buckets them by rollout state.
 *
 * Use case: "Is flag X enabled in every production environment? If yes,
 * it's a candidate for removal."
 *
 * Four buckets:
 *   - everywhere-on  : enabled in every customer's production envs
 *                      → safe to remove (feature is universal)
 *   - mixed          : enabled in some customers but not others
 *                      → intentional differentiation, don't touch
 *   - everywhere-off : disabled in every production env
 *                      → unused, candidate for removal
 *   - dev-only       : enabled only in non-production envs
 *                      → still being rolled out, don't remove
 */

/**
 * Aggregate feature flags across environments.
 *
 * @param {Array<object>} environments — full environment list from customer store
 * @returns {object} { flags, customers, stats }
 */
function aggregateFeatureFlags(environments) {
  // Only consider environments where we have feature data
  const envsWithData = (environments || []).filter(e =>
    e.features && Array.isArray(e.features.dbFeatureFlags) && e.features.dbFeatureFlags.length > 0
  );

  // Split into prod vs non-prod
  const prodEnvs = envsWithData.filter(e => e.tier === 'production');
  const nonProdEnvs = envsWithData.filter(e => e.tier !== 'production');

  // Collect the set of customers that have at least one prod env with data
  const customersInProd = new Set(prodEnvs.map(e => e.customerId));
  const customers = [...customersInProd].sort();

  // Group prod envs by customer
  const prodEnvsByCustomer = new Map();
  for (const e of prodEnvs) {
    if (!prodEnvsByCustomer.has(e.customerId)) {
      prodEnvsByCustomer.set(e.customerId, []);
    }
    prodEnvsByCustomer.get(e.customerId).push(e);
  }

  // Build a map of all known flag keys (union across all envs)
  const flagKeys = new Set();
  const flagMeta = new Map(); // key -> { isMobileFeature }
  for (const e of envsWithData) {
    for (const flag of e.features.dbFeatureFlags) {
      if (!flag || !flag.key) continue;
      flagKeys.add(flag.key);
      if (!flagMeta.has(flag.key)) {
        flagMeta.set(flag.key, { isMobileFeature: !!flag.isMobileFeature });
      }
    }
  }

  // For each flag, compute per-customer state
  const flags = [];
  for (const key of flagKeys) {
    const meta = flagMeta.get(key) || {};
    const customerStates = {};  // customerId -> 'on' | 'off' | 'partial' | 'unknown'

    for (const customerId of customers) {
      const envs = prodEnvsByCustomer.get(customerId) || [];
      if (envs.length === 0) {
        customerStates[customerId] = 'unknown';
        continue;
      }

      let enabledCount = 0;
      const totalCount = envs.length;
      for (const env of envs) {
        const flag = env.features.dbFeatureFlags.find(f => f.key === key);
        if (flag && flag.enabled) enabledCount++;
      }

      if (enabledCount === 0) {
        // Flag not enabled in any env — but did it exist in at least one?
        const anyPresent = envs.some(e => e.features.dbFeatureFlags.some(f => f.key === key));
        customerStates[customerId] = anyPresent ? 'off' : 'unknown';
      } else if (enabledCount === totalCount) {
        customerStates[customerId] = 'on';
      } else {
        customerStates[customerId] = 'partial';
      }
    }

    // Check non-prod for dev-only classification
    let enabledInAnyNonProd = false;
    for (const env of nonProdEnvs) {
      const flag = env.features.dbFeatureFlags.find(f => f.key === key);
      if (flag && flag.enabled) {
        enabledInAnyNonProd = true;
        break;
      }
    }

    // Classify into one of the four buckets.
    // Unknown states count — a flag can only be "everywhere-on" or "everywhere-off"
    // if every customer with prod envs has a definitive state.
    const stateValues = Object.values(customerStates);
    const allOn = stateValues.length > 0 && stateValues.every(s => s === 'on');
    const allOff = stateValues.length > 0 && stateValues.every(s => s === 'off');
    const hasAny = stateValues.some(s => s === 'on' || s === 'partial');

    const hasUnknown = stateValues.some(s => s === 'unknown');

    let bucket;
    if (allOn) {
      bucket = 'everywhere-on';
    } else if (allOff) {
      bucket = enabledInAnyNonProd ? 'dev-only' : 'everywhere-off';
    } else if (hasAny || hasUnknown) {
      // Any mix of on/off/partial/unknown → mixed
      bucket = 'mixed';
    } else {
      // No customers at all (shouldn't happen, but safe fallback)
      bucket = 'everywhere-off';
    }

    // Count outliers for "everywhere-on" — envs where the flag is disabled
    // even though the customer is mostly on
    const outliers = [];
    if (bucket === 'everywhere-on' || bucket === 'mixed') {
      for (const env of prodEnvs) {
        const flag = env.features.dbFeatureFlags.find(f => f.key === key);
        if (!flag) continue;
        const customerState = customerStates[env.customerId];
        if (customerState === 'partial') {
          outliers.push({
            envId: env.id,
            customerId: env.customerId,
            enabled: flag.enabled,
          });
        }
      }
    }

    // Per-customer environment breakdown — for the detail panel
    // customerEnvs: { customerId → [{ envId, envName, tier, franchise, enabled }] }
    const customerEnvs = {};
    for (const customerId of customers) {
      const envs = prodEnvsByCustomer.get(customerId) || [];
      const envDetails = [];
      for (const env of envs) {
        const flag = env.features.dbFeatureFlags.find(f => f.key === key);
        envDetails.push({
          envId: env.id,
          envName: env.name || env.nodeEnv || env.id,
          tier: env.tier,
          franchise: env.franchise || null,
          franchiseDisplayName: env.franchiseDisplayName || null,
          enabled: flag ? flag.enabled : null,
        });
      }
      if (envDetails.length > 0) {
        customerEnvs[customerId] = envDetails;
      }
    }

    flags.push({
      key,
      bucket,
      isMobileFeature: meta.isMobileFeature,
      customerStates,
      customerEnvs,
      outliers,
      enabledInAnyNonProd,
    });
  }

  // Sort flags alphabetically within each bucket
  flags.sort((a, b) => a.key.localeCompare(b.key));

  // Stats
  const stats = {
    totalFlags: flags.length,
    totalProdEnvs: prodEnvs.length,
    totalCustomers: customers.length,
    totalEnvsWithData: envsWithData.length,
    buckets: {
      'everywhere-on': flags.filter(f => f.bucket === 'everywhere-on').length,
      'mixed': flags.filter(f => f.bucket === 'mixed').length,
      'everywhere-off': flags.filter(f => f.bucket === 'everywhere-off').length,
      'dev-only': flags.filter(f => f.bucket === 'dev-only').length,
    },
  };

  return { flags, customers, stats };
}

/**
 * Aggregate DB integrations across prod environments.
 * Same bucket logic as feature flags, but the "enabled" signal comes from
 * IntegrationsConfig (DB) and each entry has both `enabled` and `configured`.
 *
 * A row is one integration type (e.g., quickBooks, salesforce, docusign).
 *
 * Additional info per integration compared to features:
 *   - 'configured' flag from the DB (indicates OAuth completed, etc.)
 *   - Some integrations can be enabled-but-not-configured (admin toggled but never set up)
 */
function aggregateIntegrations(environments) {
  const envsWithData = (environments || []).filter(e =>
    e.integrations && e.integrations.dbIntegrations && Object.keys(e.integrations.dbIntegrations).length > 0
  );

  const prodEnvs = envsWithData.filter(e => e.tier === 'production');
  const nonProdEnvs = envsWithData.filter(e => e.tier !== 'production');

  const customersInProd = new Set(prodEnvs.map(e => e.customerId));
  const customers = [...customersInProd].sort();

  const prodEnvsByCustomer = new Map();
  for (const e of prodEnvs) {
    if (!prodEnvsByCustomer.has(e.customerId)) {
      prodEnvsByCustomer.set(e.customerId, []);
    }
    prodEnvsByCustomer.get(e.customerId).push(e);
  }

  // Union of all integration types known across all envs
  const typeKeys = new Set();
  for (const e of envsWithData) {
    for (const type of Object.keys(e.integrations.dbIntegrations || {})) {
      typeKeys.add(type);
    }
  }

  const integrations = [];
  for (const type of typeKeys) {
    const customerStates = {};
    const customerConfigured = {}; // customerId -> true if configured in any env

    for (const customerId of customers) {
      const envs = prodEnvsByCustomer.get(customerId) || [];
      if (envs.length === 0) {
        customerStates[customerId] = 'unknown';
        customerConfigured[customerId] = false;
        continue;
      }

      let enabledCount = 0;
      const totalCount = envs.length;
      let anyConfigured = false;
      for (const env of envs) {
        const entry = env.integrations.dbIntegrations[type];
        if (entry) {
          if (entry.enabled) enabledCount++;
          if (entry.configured) anyConfigured = true;
        }
      }

      if (enabledCount === 0) {
        const anyPresent = envs.some(e => e.integrations.dbIntegrations[type] !== undefined);
        customerStates[customerId] = anyPresent ? 'off' : 'unknown';
      } else if (enabledCount === totalCount) {
        customerStates[customerId] = 'on';
      } else {
        customerStates[customerId] = 'partial';
      }
      customerConfigured[customerId] = anyConfigured;
    }

    // Non-prod check for dev-only bucket
    let enabledInAnyNonProd = false;
    for (const env of nonProdEnvs) {
      const entry = env.integrations.dbIntegrations[type];
      if (entry && entry.enabled) {
        enabledInAnyNonProd = true;
        break;
      }
    }

    const stateValues = Object.values(customerStates);
    const allOn = stateValues.length > 0 && stateValues.every(s => s === 'on');
    const allOff = stateValues.length > 0 && stateValues.every(s => s === 'off');
    const hasAny = stateValues.some(s => s === 'on' || s === 'partial');
    const hasUnknown = stateValues.some(s => s === 'unknown');

    let bucket;
    if (allOn) {
      bucket = 'everywhere-on';
    } else if (allOff) {
      bucket = enabledInAnyNonProd ? 'dev-only' : 'everywhere-off';
    } else if (hasAny || hasUnknown) {
      bucket = 'mixed';
    } else {
      bucket = 'everywhere-off';
    }

    // Outliers: envs inside a customer with partial state
    const outliers = [];
    if (bucket === 'everywhere-on' || bucket === 'mixed') {
      for (const env of prodEnvs) {
        const entry = env.integrations.dbIntegrations[type];
        if (!entry) continue;
        const customerState = customerStates[env.customerId];
        if (customerState === 'partial') {
          outliers.push({
            envId: env.id,
            customerId: env.customerId,
            enabled: entry.enabled,
            configured: entry.configured,
          });
        }
      }
    }

    // Per-customer environment breakdown
    const customerEnvs = {};
    for (const customerId of customers) {
      const envs = prodEnvsByCustomer.get(customerId) || [];
      const envDetails = [];
      for (const env of envs) {
        const entry = env.integrations.dbIntegrations[type];
        envDetails.push({
          envId: env.id,
          envName: env.name || env.nodeEnv || env.id,
          tier: env.tier,
          franchise: env.franchise || null,
          franchiseDisplayName: env.franchiseDisplayName || null,
          enabled: entry ? entry.enabled : null,
          configured: entry ? entry.configured : null,
        });
      }
      if (envDetails.length > 0) {
        customerEnvs[customerId] = envDetails;
      }
    }

    integrations.push({
      type,
      bucket,
      customerStates,
      customerConfigured,
      customerEnvs,
      outliers,
      enabledInAnyNonProd,
    });
  }

  integrations.sort((a, b) => a.type.localeCompare(b.type));

  const stats = {
    totalIntegrations: integrations.length,
    totalProdEnvs: prodEnvs.length,
    totalCustomers: customers.length,
    totalEnvsWithData: envsWithData.length,
    buckets: {
      'everywhere-on': integrations.filter(i => i.bucket === 'everywhere-on').length,
      'mixed': integrations.filter(i => i.bucket === 'mixed').length,
      'everywhere-off': integrations.filter(i => i.bucket === 'everywhere-off').length,
      'dev-only': integrations.filter(i => i.bucket === 'dev-only').length,
    },
  };

  return { integrations, customers, stats };
}

module.exports = { aggregateFeatureFlags, aggregateIntegrations };
