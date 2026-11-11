import { appendFileSync } from 'node:fs';

appendFileSync(process.env.FAKE_DESKPET_CALLS, `${JSON.stringify(process.argv.slice(2))}\n`);
if (process.env.FAKE_DESKPET_FAIL === '1' ||
  (process.env.FAKE_DESKPET_FAIL === 'resolve' && process.argv.includes('resolve'))) process.exitCode = 1;
