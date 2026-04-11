const log = require('./log');

/**
 * Release Notes Generator.
 *
 * Takes release truth data and produces structured markdown suitable for
 * Gamma presentation generation. Uses Claude API for intelligent structuring
 * or falls back to template-based generation if no AI key is configured.
 */
class ReleaseNotesGenerator {
  constructor(releaseTruth, releases, repoManager, config) {
    this.releaseTruth = releaseTruth;
    this.releases = releases;
    this.repoManager = repoManager;
    this.config = config;
    this.anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  }

  /**
   * Generate presentation-ready markdown for a release.
   *
   * @param {string} repo
   * @param {string} version — target release version
   * @param {string} [compareVersion] — optional base version for impact diff
   * @returns {Promise<{ markdown: string, metadata: object }>}
   */
  async generate(repo, version, compareVersion = null) {
    // Gather all the data
    const context = await this._gatherContext(repo, version, compareVersion);

    if (this.anthropicKey) {
      return this._generateWithClaude(context);
    }
    return this._generateFromTemplate(context);
  }

  async _gatherContext(repo, version, compareVersion) {
    const release = this.releases.get(version, repo);
    if (!release) throw new Error(`Release ${repo}:${version} not found`);

    // Get full truth
    const truth = await this.releaseTruth.compute(repo, version);

    // Get impact if comparing
    let impact = null;
    if (compareVersion) {
      try {
        impact = await this.releaseTruth.computeImpact(repo, version, compareVersion);
      } catch (err) {
        log.warn(`Release notes: impact computation failed for ${compareVersion}→${version}: ${err.message}`);
      }
    }

    // Get commit messages
    let commits = [];
    const repoConfig = this.config.repos.find(r => r.name === repo);
    if (repoConfig && release.branch) {
      try {
        const JiraClient = require('../integrations/jira');
        const jiraProject = repoConfig.jiraProject || 'DEV';
        commits = await this.repoManager.commitsWithJiraKeys(repo, release.branch, jiraProject);
        // If impact mode, filter to delta commits only
        if (compareVersion) {
          const prodBranch = `${repoConfig.releaseBranchPrefix || 'releases/'}${compareVersion}`;
          try {
            const mergeBase = await this.repoManager.mergeBase(repo, prodBranch, release.branch);
            if (mergeBase) {
              const range = `${mergeBase}..${release.branch}`;
              commits = await this.repoManager.log(repo, range);
            }
          } catch { /* use all commits */ }
        }
      } catch (err) {
        log.warn(`Release notes: failed to get commits: ${err.message}`);
      }
    }

    // Use impact tickets if available, otherwise full truth
    const tickets = impact
      ? impact.delta.tickets.new
      : truth.verified;

    const rogues = impact
      ? impact.delta.rogues
      : truth.rogues;

    return {
      release,
      repo,
      version,
      compareVersion,
      truth,
      impact,
      tickets,
      rogues,
      commits: commits.slice(0, 50), // Cap to avoid huge prompts
      rollup: impact ? impact.delta.rollup : truth.rollup,
    };
  }

  async _generateWithClaude(context) {
    const prompt = this._buildPrompt(context);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Claude API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    const markdown = data.content[0].text;

    return {
      markdown,
      metadata: {
        model: 'claude-sonnet-4-20250514',
        ticketCount: context.tickets.length,
        rogueCount: context.rogues.length,
        compareVersion: context.compareVersion,
      },
    };
  }

  _buildPrompt(context) {
    const { release, version, compareVersion, tickets, rogues, rollup, commits } = context;

    // Group tickets by component/theme
    const byComponent = new Map();
    for (const t of tickets) {
      const comp = t.component || 'General';
      if (!byComponent.has(comp)) byComponent.set(comp, []);
      byComponent.get(comp).push(t);
    }

    // Format tickets for the prompt
    const ticketLines = tickets.map(t => {
      const tags = (t.customerTags || []).join(', ');
      return `- ${t.key}: ${t.summary} [${t.type || 'Task'}] [${t.jiraStatus}]${t.component ? ` [${t.component}]` : ''}${tags ? ` (${tags})` : ''}`;
    }).join('\n');

    const rogueLines = rogues.map(r =>
      `- ${r.key}: ${r.summary || r.commitMessage || 'No description'}${r.fixVersions ? ` [fix: ${r.fixVersions.join(', ')}]` : ''}`
    ).join('\n');

    const commitLines = commits.slice(0, 30).map(c =>
      `- ${c.sha?.substring(0, 7) || '?'}: ${(c.message || '').substring(0, 100)}`
    ).join('\n');

    const header = compareVersion
      ? `Changes from ${compareVersion} to ${version}`
      : `Full release: ${version}`;

    return `You are writing release notes for a Gamma presentation (slide deck). The audience is the QA and engineering team at Viv Technologies, a home care technology company.

Release: ${version}
${compareVersion ? `Compared against: ${compareVersion}` : ''}
Repository: ${context.repo}
Release date: ${release.jiraReleaseDate || 'TBD'}
State: ${release.state}

Rollup: ${rollup.planned} planned, ${rollup.done} done, ${rollup.inQa} in QA, ${rollup.inDev} in dev, ${rollup.attention || 0} attention

TICKETS (${tickets.length}):
${ticketLines || 'None'}

${rogues.length > 0 ? `ROGUE COMMITS (${rogues.length} — on branch but not in JIRA fixVersion):\n${rogueLines}\n` : ''}
${commits.length > 0 ? `RECENT COMMITS (${commits.length}):\n${commitLines}\n` : ''}

Generate a presentation-ready markdown document with these rules:
1. Use \\n---\\n to separate slides (Gamma will split on these)
2. First slide: title slide with release version, date, and a one-line summary
3. Second slide: high-level summary — ticket count by type (bugs, enhancements, tasks), key themes
4. Group remaining slides by component/theme — each theme gets its own slide
5. For each ticket, write a clear one-liner explaining the change (not the JIRA summary verbatim — rephrase for clarity)
6. If there are rogue commits, add a slide for "Unplanned Changes" at the end
7. Final slide: deployment readiness summary (rollup stats, any concerns)
8. Keep language concise and professional — no fluff
9. Use bullet points, not paragraphs
10. Include the JIRA key (e.g., DEV-45661) next to each item for traceability

Output ONLY the markdown, no explanation or wrapper.`;
  }

  /**
   * Fallback: template-based generation without AI.
   */
  _generateFromTemplate(context) {
    const { release, version, compareVersion, tickets, rogues, rollup } = context;
    const lines = [];

    // Title slide
    lines.push(`# ${version} — Release Notes`);
    lines.push(`Viv Technologies · ${release.jiraReleaseDate || 'Date TBD'}`);
    lines.push(`${tickets.length} tickets${compareVersion ? ` (diff from ${compareVersion})` : ''}`);
    lines.push('\n---\n');

    // Summary slide
    lines.push('## Summary');
    lines.push(`- **${rollup.planned}** planned tickets`);
    lines.push(`- **${rollup.done}** done · **${rollup.inQa}** in QA · **${rollup.inDev}** in dev`);
    if (rollup.attention) lines.push(`- **${rollup.attention}** need attention`);
    lines.push('\n---\n');

    // Group by component
    const byComponent = new Map();
    for (const t of tickets) {
      const comp = t.component || 'General';
      if (!byComponent.has(comp)) byComponent.set(comp, []);
      byComponent.get(comp).push(t);
    }

    for (const [comp, compTickets] of byComponent) {
      lines.push(`## ${comp}`);
      for (const t of compTickets) {
        const type = t.type ? `[${t.type}]` : '';
        lines.push(`- **${t.key}** ${t.summary} ${type}`);
      }
      lines.push('\n---\n');
    }

    // Rogues
    if (rogues.length > 0) {
      lines.push('## Unplanned Changes');
      for (const r of rogues) {
        lines.push(`- **${r.key}** ${r.summary || r.commitMessage || 'No description'}`);
      }
      lines.push('\n---\n');
    }

    // Readiness
    lines.push('## Deployment Readiness');
    lines.push(`- State: **${release.state}**`);
    lines.push(`- ${rollup.done}/${rollup.planned} tickets done`);
    if (rogues.length > 0) lines.push(`- ${rogues.length} rogue commits (unplanned)`);

    return {
      markdown: lines.join('\n'),
      metadata: {
        model: 'template',
        ticketCount: tickets.length,
        rogueCount: rogues.length,
        compareVersion,
      },
    };
  }
}

module.exports = ReleaseNotesGenerator;
