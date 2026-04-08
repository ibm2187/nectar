/**
 * Multi-format version extraction.
 * Reads version from different sources based on repo config.
 */

/**
 * Read the version for a release branch from its repo.
 * @param {RepoManager} repoManager
 * @param {string} repoName
 * @param {string} branch - The release branch name
 * @param {object} versionSource - Repo's versionSource config
 * @returns {string|null}
 */
async function readVersion(repoManager, repoName, branch, versionSource) {
  if (!versionSource) return null;

  switch (versionSource.type) {
    case 'file': {
      // Simple file containing version string (e.g., .version)
      const content = await repoManager.readFile(repoName, branch, versionSource.path);
      return content ? content.trim() : null;
    }

    case 'gradle-toml': {
      // gradle/libs.versions.toml — parse key = "value" format
      const content = await repoManager.readFile(repoName, branch, versionSource.path);
      if (!content) return null;
      const key = versionSource.key || 'versionName';
      const match = content.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
      return match ? match[1] : null;
    }

    case 'plist': {
      // Search for MARKETING_VERSION in .pbxproj files
      // We can't easily parse binary plists from git show, so extract from branch name
      // Fallback: the version IS the branch name after the prefix
      return null; // Version extracted from branch name by discovery engine
    }

    case 'package-json': {
      const content = await repoManager.readFile(repoName, branch, versionSource.path || 'package.json');
      if (!content) return null;
      try {
        const pkg = JSON.parse(content);
        return pkg.version || null;
      } catch {
        return null;
      }
    }

    default:
      return null;
  }
}

module.exports = { readVersion };
