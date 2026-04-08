const log = require('./log');

/**
 * Webplatform environment scanner.
 *
 * Reads customer & environment definitions from webplatform's
 * server/config/environment/ directory by scanning the bare git clone
 * and regex-parsing the JS config files.
 *
 * Each customer brand is a subdirectory; each .js file is an environment.
 * Files with 'feature-config', 'template', 'defaults', '.spec', 'syncrotist'
 * in their names are skipped (they're not deployment environments).
 */

// Known customer brands. Order matters — used for display grouping.
const KNOWN_BRANDS = [
  { id: 'bayada',      name: 'Bayada Home Health',    dir: 'bayada' },
  { id: 'ck',          name: 'Comfort Keepers',       dir: 'ck' },
  { id: 'tribute',     name: 'Tribute Home Care',     dir: 'tribute' },
  { id: 'haven',       name: 'Haven Home Care',       dir: 'haven' },
  { id: 'lumen',       name: 'Help at Home',          dir: 'lumen' },
  { id: 'qualitycare', name: 'Quality Care',          dir: 'qualitycare' },
  { id: 'viv',         name: 'Mavencare (Internal)',  dir: 'viv' },
];

// Patterns for files to skip (not real environments)
const SKIP_PATTERNS = [
  /feature-config/i,
  /template/i,
  /defaults?/i,
  /\.spec\./i,
  /^syncrotist\.js$/,
  /^index\.js$/,
];

// Map a filename to its tier
function detectTier(filename, brandId) {
  const base = filename.replace('.js', '');
  const lower = base.toLowerCase();

  // Exact brand name = production
  if (base === brandId || base === `${brandId}-production` || base === `${brandId}prod` || base === 'lumen-production') return 'production';

  // viv brand has special bare-filename envs (no brand prefix)
  if (brandId === 'viv') {
    if (lower === 'production') return 'production';
    if (lower === 'preprod' || lower === 'preprod-staging') return 'staging';
    if (lower === 'development' || lower === 'dev' || /^dev\d+$/.test(lower)) return 'dev';
    if (lower === 'demo') return 'demo';
    if (lower === 'test' || lower === 'testing') return 'test';
    if (lower === 'integration') return 'integration';
    if (lower === 'sandbox' || /^sandbox\d+$/.test(lower)) return 'sandbox';
    if (lower.startsWith('dev-')) return 'dev';
  }

  // Suffix detection (for envs prefixed with brand name like bayada-staging)
  if (lower.endsWith('-staging') || lower.endsWith('prod-staging')) return 'staging';
  if (lower.endsWith('-uat')) return 'uat';
  if (lower.endsWith('-training')) return 'training';
  if (lower.endsWith('-sandbox')) return 'sandbox';
  if (lower.endsWith('-loadtest')) return 'loadtest';
  if (lower.endsWith('-demo')) return 'demo';
  if (lower.endsWith('-integration')) return 'integration';
  if (lower.endsWith('-test')) return 'test';
  if (lower.includes('-qa')) return 'qa';
  if (/-\d+$/.test(lower)) return 'production'; // ck-615, ck-1097 → franchise prods
  return 'other';
}

// Extract the franchise ID from a CK filename like "ck-615.js"
function extractFranchise(filename, brandId) {
  if (brandId !== 'ck') return null;
  const m = filename.match(/^ck-(\d+)\.js$/);
  return m ? m[1] : null;
}

// Regex-parse a config file to extract key fields
function parseConfigFile(content) {
  // Match simple string assignments: key: 'value' or key: "value"
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
    const seenCustomers = new Set();

    // Make sure we have latest master
    try {
      await this.repoManager.fetch('webplatform');
    } catch (err) {
      log.warn(`WebplatformScanner: fetch failed — ${err.message}`);
    }

    for (const brand of KNOWN_BRANDS) {
      const files = await this._listBrandFiles(brand.dir);
      if (!files.length) continue;

      // Determine the "main" customer metadata from the root brand file
      const mainFile = files.find(f => f.replace('.js', '') === brand.id) || files[0];
      const mainContent = await this._readFile(`${brand.dir}/${mainFile}`);
      const mainParsed = mainContent ? parseConfigFile(mainContent) : {};

      // Build Customer record
      // Prefer our curated names over webplatform's mobileOrgName which can be weird
      // (e.g., CKFI, "Help At Home Integration", "Vivtechnologies - Demo")
      const integrations = [];
      if (mainParsed.ascendEnabled) integrations.push('ascend');
      const customer = {
        id: brand.id,
        name: brand.name,                                  // curated display name
        configName: mainParsed.mobileOrgName || null,      // raw webplatform name
        domain: mainParsed.eppDomain || null,
        domainPrefix: mainParsed.domainPrefix || brand.id,
        integrations,
        hasFranchises: brand.id === 'ck',
        active: true,
        syncedFrom: 'webplatform',
        lastSyncedAt: new Date().toISOString(),
      };
      customers.push(customer);
      seenCustomers.add(brand.id);

      // Build Environment records for each file in the brand dir
      for (const file of files) {
        if (SKIP_PATTERNS.some(p => p.test(file))) continue;

        const content = await this._readFile(`${brand.dir}/${file}`);
        if (!content) continue;

        const parsed = parseConfigFile(content);

        // The env name is ALWAYS derived from the filename — that's how
        // webplatform's config loader works (it does require(`./brand/${NODE_ENV}`)).
        // Many files (e.g. viv/demo.js, viv/development.js) don't declare `env:` in
        // their content but are still valid environments keyed by filename.
        const envName = file.replace(/\.js$/, '');
        // Safety: if the file explicitly sets env: '...' and it conflicts, prefer the
        // explicit value (this handles edge cases like legacy files).
        const effectiveEnvName = parsed.env || envName;

        const tier = detectTier(file, brand.id);
        const franchise = extractFranchise(file, brand.id);

        // Derive URL / domainPrefix from parsed content, or fall back to defaults
        const domainPrefix = parsed.domainPrefix || effectiveEnvName;
        const derivedUrl = parsed.link
          || (parsed.eppDomain ? `https://${domainPrefix}.${parsed.eppDomain}` : null);

        // Build environment
        const env = {
          id: effectiveEnvName,
          nodeEnv: effectiveEnvName,
          customerId: brand.id,
          franchise,
          franchiseDisplayName: franchise ? (parsed.mobileOrgName || `CK ${franchise}`) : null,
          tier,
          name: parsed.mobileOrgName || effectiveEnvName,
          url: derivedUrl,
          versionEndpoint: derivedUrl ? `${derivedUrl.replace(/\/$/, '')}/api/status/version` : null,

          // Live state — default unknown
          currentVersion: null,
          currentBranch: null,
          lastChecked: null,
          reachable: null,

          // Meta
          disabled: false,
          ascendEnabled: parsed.ascendEnabled,
          disableOutgoingCommunication: parsed.disableOutgoingCommunication,
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

  /**
   * List .js files in a brand directory from master branch.
   */
  async _listBrandFiles(dir) {
    try {
      // Use git ls-tree to list files in the directory
      const output = await this.repoManager._git('webplatform', [
        'ls-tree', '--name-only', `master:server/config/environment/${dir}`,
      ]);
      return output.trim().split('\n').filter(Boolean).filter(f => f.endsWith('.js'));
    } catch (err) {
      log.warn(`WebplatformScanner: failed to list ${dir} — ${err.message}`);
      return [];
    }
  }

  /**
   * Read a file from master via git show.
   */
  async _readFile(relativePath) {
    return this.repoManager.readFile('webplatform', 'master', `server/config/environment/${relativePath}`);
  }

  getStatus() {
    return this.lastScan;
  }
}

module.exports = WebplatformScanner;
