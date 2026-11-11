import { readFileSync, writeFileSync } from 'node:fs';

const scenarios = JSON.parse(readFileSync(new URL('./orca-sequences.json', import.meta.url), 'utf8'));
const scenario = scenarios[process.env.FAKE_ORCA_SCENARIO];
if (!scenario) throw new Error('Unknown fake Orca scenario');
const cursorPath = process.env.FAKE_ORCA_CURSOR;
let cursor;
try { cursor = JSON.parse(readFileSync(cursorPath, 'utf8')); }
catch { cursor = { poll: -1, calls: {} }; }
const argv = process.argv.slice(2);
if (argv[0] !== 'orchestration') throw new Error('Expected orchestration command');
const action = argv[1];
if (action === 'worker-list') cursor.poll++;
const poll = scenario.polls[Math.min(cursor.poll, scenario.polls.length - 1)];
cursor.calls[action] = (cursor.calls[action] ?? 0) + 1;
writeFileSync(cursorPath, JSON.stringify(cursor));
let result;
if (action === 'worker-list') result = { workers: poll.workers, page: { hasMore: false, nextCursor: null } };
else if (action === 'check') result = { messages: poll.messages ?? [] };
else if (action === 'worker-read') {
  const id = argv[argv.indexOf('--dispatch') + 1];
  result = { terminal: poll.reads?.[id] ?? { tail: [] } };
} else throw new Error(`Unexpected command: ${action}`);
if (poll.error === action) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'temporary', message: 'temporary fake Orca error' } }));
  process.exitCode = 1;
} else process.stdout.write(JSON.stringify({ ok: true, result }));
