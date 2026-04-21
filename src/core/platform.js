/**
 * Map a release repo to its platform tag on tickets.
 * Platform tags disambiguate tickets when two releases share a clean version
 * number (e.g. iOS 2026.4.0 vs Android 2026.4.0 both stored as "2026.4.0").
 */
function repoToPlatform(repo) {
  if (repo === 'ios') return 'ios';
  if (repo === 'android') return 'android';
  if (repo === 'webplatform' || repo === 'bluesummit') return 'web';
  return null;
}

module.exports = { repoToPlatform };
