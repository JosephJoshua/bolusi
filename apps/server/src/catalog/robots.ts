// A small robots.txt reader for the catalog crawl: the group for our agent (or `*`), its Allow and
// Disallow prefixes with `*` and `$`, and the longest match deciding, as RFC 9309 describes.
interface Rule {
  readonly allow: boolean;
  readonly pattern: RegExp;
  readonly length: number;
}

function compile(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export class RobotsRules {
  private constructor(private readonly rules: readonly Rule[]) {}

  static allowAll(): RobotsRules {
    return new RobotsRules([]);
  }

  static denyAll(): RobotsRules {
    return new RobotsRules([{ allow: false, pattern: /^/, length: 0 }]);
  }

  /** The rules for `agent` (case-insensitive product token), else those for `*`. */
  static parse(text: string, agent: string): RobotsRules {
    const groups: { agents: string[]; rules: Rule[] }[] = [];
    let current: { agents: string[]; rules: Rule[] } | null = null;
    let inAgents = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (field === 'user-agent') {
        if (current === null || !inAgents) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        inAgents = true;
      } else if ((field === 'allow' || field === 'disallow') && current !== null) {
        inAgents = false;
        // An empty Disallow allows everything; it adds no rule.
        if (value === '') continue;
        current.rules.push({
          allow: field === 'allow',
          pattern: compile(value),
          length: value.length,
        });
      } else {
        inAgents = false;
      }
    }
    const token = agent.toLowerCase();
    const own = groups.filter((g) => g.agents.includes(token));
    const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'));
    return new RobotsRules(chosen.flatMap((g) => g.rules));
  }

  allows(path: string): boolean {
    let best: Rule | null = null;
    for (const rule of this.rules) {
      if (!rule.pattern.test(path)) continue;
      // The longest pattern wins; on a tie Allow wins.
      if (
        best === null ||
        rule.length > best.length ||
        (rule.length === best.length && rule.allow)
      ) {
        best = rule;
      }
    }
    return best === null || best.allow;
  }
}
