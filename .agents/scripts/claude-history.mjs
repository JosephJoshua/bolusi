import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const primarySession = join(
  homedir(),
  '.claude/projects/-home-joseph-bolusi/5ecb3e99-8eba-4534-b067-ae335593504b.jsonl',
);
const argumentsList = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argumentsList.indexOf(name);
  return index < 0 ? fallback : argumentsList[index + 1];
};
const file = option('--file', primarySession);
const query = option('--search', '')?.toLowerCase();
const last = Number(option('--last', '20'));

const validOptions = ['--file', '--search', '--last'];
const invalidArguments = argumentsList.some(
  (argument, index) =>
    (index % 2 === 0 && !validOptions.includes(argument)) ||
    (index % 2 === 1 && argument.startsWith('--')),
);

if (
  !file ||
  query === undefined ||
  !Number.isSafeInteger(last) ||
  last < 1 ||
  last > 500 ||
  argumentsList.length % 2 !== 0 ||
  invalidArguments
) {
  console.error(
    'Usage: node .agents/scripts/claude-history.mjs [--file JSONL] [--search text] [--last 1..500]',
  );
  process.exitCode = 1;
} else {
  const matches = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  for await (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n')
          : '';
    if (!text || !text.toLowerCase().includes(query)) continue;
    matches.push(`${entry.timestamp ?? 'unknown time'} ${entry.type}: ${text.slice(0, 1200)}`);
    if (matches.length > last) matches.shift();
  }
  console.log(matches.join('\n\n---\n\n'));
}
