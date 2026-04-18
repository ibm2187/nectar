const log = require('./log');

/**
 * Webplatform environment scanner.
 *
 * TWO-PASS approach:
 *   1. **Tofu scan** (primary) — reads `devops/tofu/environments/` from the bare
 *      git clone. Each subdirectory is a deployed environment. This is the
 *      authoritative list of what actually exists in infrastructure.
 *   2. **Config scan** (enrichment) — reads `server/config/environment/` to pull
 *      feature flags, integrations, domain prefixes, etc. for each environment
 *      found in step 1. Environments without an explicit config file use the
 *      brand template (e.g., ck-template.js).
 */

// Known customer brands. Order matters — used for display grouping.
// urlPrefix: used to derive URLs for template-based envs where the regex
// parser can't evaluate JS template literals. E.g., CK's template generates
// `https://comfortkeepers-${deploymentId}.vivtechnologies.com` — so the
// urlPrefix is 'comfortkeepers' and eppDomain is 'vivtechnologies.com'.
const KNOWN_BRANDS = [
  { id: 'bayada',      name: 'Bayada Home Health',    dir: 'bayada',      tofuDir: 'bayada',  urlPrefix: 'bayada',         eppDomain: 'vivtechnologies.com' },
  { id: 'ck',          name: 'Comfort Keepers',       dir: 'ck',          tofuDir: 'ck',      urlPrefix: 'comfortkeepers', eppDomain: 'vivtechnologies.com' },
  { id: 'tribute',     name: 'Tribute Home Care',     dir: 'tribute',     tofuDir: 'tribute', urlPrefix: 'tribute',        eppDomain: 'mavencare.com' },
  { id: 'haven',       name: 'Haven Home Care',       dir: 'haven',       tofuDir: 'tribute', urlPrefix: 'haven',          eppDomain: 'mavencare.com' },
  { id: 'lumen',       name: 'Help at Home',          dir: 'lumen',       tofuDir: 'lumen',   urlPrefix: 'lumen',          eppDomain: 'vivtechnologies.com' },
  { id: 'qualitycare', name: 'Quality Care',          dir: 'qualitycare', tofuDir: 'tribute', urlPrefix: 'qualitycare',    eppDomain: 'vivtechnologies.com' },
  { id: 'viv',         name: 'Viv (Internal)',        dir: 'viv',         tofuDir: 'viv',     urlPrefix: 'viv',            eppDomain: 'vivtechnologies.com' },
];

// Map tofu env name → brand id (for envs that aren't prefixed with brand name)
const TOFU_ENV_TO_BRAND = {
  'haven': 'haven',
  'qualitycare': 'qualitycare',
  'demo': 'viv',
  'training': 'viv',
};

// Skip these tofu directories — not real environments
const TOFU_SKIP = new Set([
  'shared-infrastructure', 'shared-modules', 'syncrotist',
  'bryan-personal',
]);

// Patterns for config files to skip (not real environments)
const SKIP_PATTERNS = [
  /feature-config/i,
  /template/i,
  /defaults?/i,
  /\.spec\./i,
  /^syncrotist\.js$/,
  /^index\.js$/,
];

// Map a filename to its tier
function detectTier(envName, brandId) {
  const lower = envName.toLowerCase();

  // Exact brand name = production
  if (envName === brandId || envName === `${brandId}-production` || envName === `${brandId}prod`) return 'production';
  if (brandId === 'lumen' && envName === 'lumen-production') return 'production';

  // viv brand has special bare-filename envs
  if (brandId === 'viv') {
    if (lower === 'production' || lower === 'webplatform-production') return 'production';
    if (lower === 'preprod' || lower === 'preprod-staging' || lower === 'webplatform-preprod') return 'staging';
    if (lower === 'development' || lower === 'dev' || lower === 'webplatform-dev' || /^dev\d+$/.test(lower)) return 'dev';
    if (lower === 'demo') return 'demo';
    if (lower === 'test' || lower === 'testing') return 'test';
    if (lower === 'integration' || lower === 'viv-integration') return 'integration';
    if (lower === 'sandbox' || /^sandbox/.test(lower)) return 'sandbox';
    if (lower === 'training') return 'training';
  }

  // Suffix detection
  if (lower.endsWith('-staging') || lower.endsWith('prod-staging')) return 'staging';
  if (lower.endsWith('-uat')) return 'uat';
  if (lower.endsWith('-training')) return 'training';
  if (lower.endsWith('-sandbox') || lower.startsWith('sandbox')) return 'sandbox';
  if (lower.endsWith('-loadtest')) return 'loadtest';
  if (lower.endsWith('-demo')) return 'demo';
  if (lower.endsWith('-integration')) return 'integration';
  if (lower.endsWith('-test') || lower.endsWith('-prod-test')) return 'test';
  if (lower.includes('-qa') || /^qa\d+$/.test(lower.replace(`${brandId}-`, ''))) return 'qa';
  if (/-\d+b?$/.test(lower)) return 'production'; // ck-615, ck-1097b → franchise prods
  if (lower.endsWith('-rcm')) return 'test';
  return 'other';
}

// Extract the franchise ID from a CK env name like "ck-615"
function extractFranchise(envName, brandId) {
  if (brandId !== 'ck') return null;
  const m = envName.match(/^ck-(\d+\w*)$/);
  return m ? m[1] : null;
}

// Regex-parse a config file to extract key fields
function parseConfigFile(content) {
  function extract(key) {
    const re = new RegExp(`\\b${key}\\s*:\\s*['"]([^'"]+)['"]`);
    const m = content.match(re);
    return m ? m[1] : null;
  }
  function extractBoolean(key) {
    const re = new RegExp(`\\b${key}\\s*:\\s*(true|false)`);
    const m = content.match(re);
    return m ? m[1] === 'true' : null;
  }

  return {
    env: extract('env'),
    mobileOrgName: extract('mobileOrgName'),
    link: extract('link'),
    website: extract('website'),
    eppDomain: extract('eppDomain'),
    domainPrefix: extract('domainPrefix'),
    authenticator: extract('authenticator'),
    disableOutgoingCommunication: extractBoolean('disableOutgoingCommunication'),
    ascendEnabled: /ascendIntegration\s*:\s*\{[^}]*enabled\s*:\s*true/.test(content),
  };
}

/**
 * Determine which brand an environment belongs to based on its tofu parent dir
 * and environment name.
 */
function resolveBrand(tofuBrandDir, envName) {
  // Explicit overrides for envs that don't follow naming convention
  if (TOFU_ENV_TO_BRAND[envName]) return TOFU_ENV_TO_BRAND[envName];

  // Tribute sub-brands: haven and qualitycare live under tribute/ in tofu
  // but are their own brands. Production names: 'haven', 'qualitycare'
  // Their "webplatform-tribute-*" envs belong to tribute itself.
  if (tofuBrandDir === 'tribute') {
    if (envName.startsWith('webplatform-tribute')) return 'tribute';
    if (envName === 'haven') return 'haven';
    if (envName === 'qualitycare') return 'qualitycare';
    return 'tribute';
  }

  if (tofuBrandDir === 'bayada-loadtest') return 'bayada';

  // For all others, the tofu dir IS the brand
  const brand = KNOWN_BRANDS.find(b => b.tofuDir === tofuBrandDir);
  return brand ? brand.id : tofuBrandDir;
}

class WebplatformScanner {
  constructor(repoManager, config) {
    this.repoManager = repoManager;
    this.config = config;
    this.lastScan = null;
  }

  /**
   * Scan the webplatform repo for all customer/environment configs.
   * Returns { customers: [...], environments: [...] }
   */
  async scan() {
    const startTime = Date.now();
    const customers = [];
    const environments = [];

    // Make sure we have latest master
    try {
      await this.repoManager.fetch('webplatform');
    } catch (err) {
      log.warn(`WebplatformScanner: fetch failed — ${err.message}`);
    }

    // ── Pass 1: Tofu scan — discover ALL deployed environments ──────
    const tofuEnvsByBrand = new Map(); // brandId → [envName, ...]

    const tofuBrandDirs = await this._listTofuBrandDirs();
    for (const tofuBrandDir of tofuBrandDirs) {
      const envDirs = await this._listTofuEnvDirs(tofuBrandDir);
      for (const envName of envDirs) {
        if (TOFU_SKIP.has(envName)) continue;
        const brandId = resolveBrand(tofuBrandDir, envName);
        if (!tofuEnvsByBrand.has(brandId)) tofuEnvsByBrand.set(brandId, []);
        tofuEnvsByBrand.get(brandId).push(envName);
      }
    }

    // ── Pass 2: For each brand, build customer + environment records ──
    for (const brand of KNOWN_BRANDS) {
      const tofuEnvs = tofuEnvsByBrand.get(brand.id) || [];

      // Also get config files — they have feature flags, integrations, etc.
      const configFiles = await this._listBrandFiles(brand.dir);
      const configByEnvName = new Map();
      for (const file of configFiles) {
        if (SKIP_PATTERNS.some(p => p.test(file))) continue;
        const envName = file.replace(/\.js$/, '');
        configByEnvName.set(envName, file);
      }

      // Read the brand's "main" config for customer metadata
      const mainFile = configFiles.find(f => f.replace('.js', '') === brand.id) || configFiles[0];
      const mainContent = mainFile ? await this._readConfigFile(`${brand.dir}/${mainFile}`) : null;
      const mainParsed = mainContent ? parseConfigFile(mainContent) : {};

      // Also read template if it exists (for brands like CK)
      let templateParsed = null;
      if (configFiles.includes(`${brand.id}-template.js`)) {
        const tplContent = await this._readConfigFile(`${brand.dir}/${brand.id}-template.js`);
        if (tplContent) templateParsed = parseConfigFile(tplContent);
      }

      // Build Customer record
      const integrations = [];
      if (mainParsed.ascendEnabled || (templateParsed && templateParsed.ascendEnabled)) {
        integrations.push('ascend');
      }
      const customer = {
        id: brand.id,
        name: brand.name,
        configName: mainParsed.mobileOrgName || null,
        domain: mainParsed.eppDomain || (templateParsed && templateParsed.eppDomain) || null,
        domainPrefix: mainParsed.domainPrefix || brand.id,
        integrations,
        hasFranchises: brand.id === 'ck',
        active: true,
        syncedFrom: 'webplatform',
        lastSyncedAt: new Date().toISOString(),
      };
      customers.push(customer);

      // Merge tofu envs + config-only envs into a single set
      const allEnvNames = new Set([...tofuEnvs]);
      for (const envName of configByEnvName.keys()) {
        allEnvNames.add(envName);
      }

      // Build Environment records
      for (const envName of allEnvNames) {
        const configFile = configByEnvName.get(envName);
        const fromTofu = tofuEnvs.includes(envName);

        // Parse config if explicit file exists, otherwise use template
        let parsed = {};
        if (configFile) {
          const content = await this._readConfigFile(`${brand.dir}/${configFile}`);
          if (content) parsed = parseConfigFile(content);
        } else if (templateParsed) {
          // No explicit config — use template defaults
          parsed = { ...templateParsed };
        }

        const tier = detectTier(envName, brand.id);
        const franchise = extractFranchise(envName, brand.id);

        // Derive URL / domainPrefix.
        // For template-based envs (no explicit config), the URL follows the
        // brand's pattern: e.g., CK ck-615 → comfortkeepers-615.vivtechnologies.com
        // The deploymentId is the env name with the brand prefix stripped.
        let domainPrefix = parsed.domainPrefix;
        if (!domainPrefix && !configFile) {
          // Template env — use brand urlPrefix + deploymentId
          const deploymentId = envName.replace(`${brand.id}-`, '');
          domainPrefix = `${brand.urlPrefix}-${deploymentId}`;
        }
        domainPrefix = domainPrefix || envName;
        // For URL derivation: if the config has an explicit `link`, use it.
        // Otherwise build from domainPrefix + eppDomain. For template envs,
        // prefer the brand-level eppDomain (vivtechnologies.com) over the
        // template's eppDomain (which is mavencare.com — the partner portal domain).
        const eppDomain = configFile ? (parsed.eppDomain || brand.eppDomain) : brand.eppDomain;
        const derivedUrl = parsed.link || `https://${domainPrefix}.${eppDomain}`;

        const env = {
          id: envName,
          nodeEnv: envName,
          customerId: brand.id,
          franchise,
          franchiseDisplayName: franchise ? (parsed.mobileOrgName || `CK ${franchise}`) : null,
          tier,
          name: parsed.mobileOrgName || envName,
          url: derivedUrl,
          versionEndpoint: derivedUrl ? `${derivedUrl.replace(/\/$/, '')}/api/status/version` : null,

          // Live state — default unknown
          currentVersion: null,
          currentBranch: null,
          lastChecked: null,
          reachable: null,

          // Meta
          disabled: false,
          ascendEnabled: parsed.ascendEnabled || (templateParsed && templateParsed.ascendEnabled) || false,
          disableOutgoingCommunication: parsed.disableOutgoingCommunication,
          hasExplicitConfig: !!configFile,
          fromTofu,
          syncedFrom: 'webplatform',
          lastSyncedAt: new Date().toISOString(),
        };

        environments.push(env);
      }
    }

    this.lastScan = {
      at: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      customerCount: customers.length,
      environmentCount: environments.length,
    };

    log.info(`Webplatform scan: ${customers.length} customers, ${environments.length} environments in ${this.lastScan.durationMs}ms`);

    return { customers, environments };
  }

  // ── Tofu helpers ────────────────────────────────────────

  /** List brand directories under devops/tofu/environments/ */
  async _listTofuBrandDirs() {
    try {
      const output = await this.repoManager._git('webplatform', [
        'ls-tree', '--name-only', 'master:devops/tofu/environments',
      ]);
      return output.trim().split('\n').filter(Boolean)
        .filter(d => d !== 'shared-modules');
    } catch (err) {
      log.warn(`WebplatformScanner: failed to list tofu brand dirs — ${err.message}`);
      return [];
    }
  }

  /** List environment directories under a tofu brand dir */
  async _listTofuEnvDirs(brandDir) {
    try {
      const output = await this.repoManager._git('webplatform', [
        'ls-tree', '--name-only', `master:devops/tofu/environments/${brandDir}`,
      ]);
      return output.trim().split('\n').filter(Boolean);
    } catch (err) {
      log.warn(`WebplatformScanner: failed to list tofu envs for ${brandDir} — ${err.message}`);
      return [];
    }
  }

  // ── Config helpers ──────────────────────────────────────

  /** List .js files in a brand's config directory from master branch. */
  async _listBrandFiles(dir) {
    try {
      const output = await this.repoManager._git('webplatform', [
        'ls-tree', '--name-only', `master:server/config/environment/${dir}`,
      ]);
      return output.trim().split('\n').filter(Boolean).filter(f => f.endsWith('.js'));
    } catch (err) {
      log.warn(`WebplatformScanner: failed to list config files for ${dir} — ${err.message}`);
      return [];
    }
  }

  /** Read a config file from master via git show. */
  async _readConfigFile(relativePath) {
    return this.repoManager.readFile('webplatform', 'master', `server/config/environment/${relativePath}`);
  }

  getStatus() {
    return this.lastScan;
  }
}

module.exports = WebplatformScanner;
