// 시험 통과 지문. tests/run.mjs가 모두 통과하면 플러그인 원본의 지문을 남기고, release.mjs는 지금 원본의 지문과 같을 때만 버전을 올린다.
// 시험을 깜빡하거나 통과한 뒤 원본을 고친 채 release하는 것을 막는다(시험 한 번이 2분 넘게 걸려 release 안에서 돌리지 않는다).
// plugin.json은 release가 버전을 올리며 바꾸므로 빼고(여러 묶음을 이어서 release해도 지문이 같다), __pycache__와 node_modules도 뺀다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS, marketplacePlugins } from './env.mjs';

export const STAMP = path.join(HARNESS, 'tests', '.passed');
const SKIP_DIRS = new Set(['__pycache__', 'node_modules', '.git']);

function walk(root, dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, full, out);
    } else if (e.isFile()) {
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (rel !== '.claude-plugin/plugin.json') out.push([rel, full]);
    }
  }
}

/** 폴더들의 파일 내용 지문(줄 끝은 LF로 맞춘다). dirs를 주지 않으면 마켓플레이스의 모든 플러그인 원본. */
export function sourcesHash(dirs) {
  const list = dirs || marketplacePlugins().map((p) => path.resolve(HARNESS, p.source));
  const h = crypto.createHash('sha256');
  for (const root of [...list].sort()) {
    if (!fs.existsSync(root)) continue;
    const files = [];
    walk(root, root, files);
    files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    h.update(`${path.basename(root)}\0`);
    for (const [rel, full] of files) {
      h.update(`${rel}\0`);
      h.update(fs.readFileSync(full).toString('latin1').replace(/\r\n/g, '\n'));
      h.update('\0');
    }
  }
  return h.digest('hex');
}

export function writeStamp() {
  fs.writeFileSync(STAMP, JSON.stringify({ hash: sourcesHash(), at: new Date().toISOString() }) + '\n');
}

/** 지금 원본이 마지막으로 시험을 통과한 원본과 같으면 null, 다르면 이유 한 줄. */
export function stampProblem() {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { /* 없음 */ }
  if (!s?.hash) return '시험을 통과한 기록이 없다';
  if (s.hash !== sourcesHash()) return `마지막으로 시험을 통과한 뒤(${s.at}) 원본이 바뀌었다`;
  return null;
}
