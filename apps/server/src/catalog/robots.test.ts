import { expect, test } from 'vitest';

import { RobotsRules } from './robots.js';

const ROBOTS = `
# comments are ignored
User-agent: *
Disallow: /search
Disallow: /*.php3?sQuickSearch
Allow: /search-help$

User-agent: BadBot
User-agent: OtherBot
Disallow: /
`;

test('the * group applies when ours is not named, longest match wins', () => {
  const rules = RobotsRules.parse(ROBOTS, 'BolusiCatalog');
  expect(rules.allows('/makers.php3')).toBe(true);
  expect(rules.allows('/samsung_galaxy_a56-13603.php')).toBe(true);
  expect(rules.allows('/search?q=a55')).toBe(false);
  expect(rules.allows('/results.php3?sQuickSearch=yes')).toBe(false);
  expect(rules.allows('/search-help')).toBe(true);
  expect(rules.allows('/search-help/more')).toBe(false);
});

test('a group naming our agent replaces the * group, including grouped agents', () => {
  expect(RobotsRules.parse(ROBOTS, 'OtherBot').allows('/makers.php3')).toBe(false);
  expect(
    RobotsRules.parse(
      'User-agent: bolusicatalog\nDisallow:\n\nUser-agent: *\nDisallow: /',
      'BolusiCatalog',
    ).allows('/x'),
  ).toBe(true);
});

test('allow-all and deny-all', () => {
  expect(RobotsRules.allowAll().allows('/anything')).toBe(true);
  expect(RobotsRules.denyAll().allows('/')).toBe(false);
});
