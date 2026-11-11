// 작업 환경 찾기와 claude CLI 호출. setup.mjs, release.mjs가 같이 쓴다.
//
// 설정 폴더는 여러 개다: ~/.claude(데스크톱 앱, CLI)와 Orca Claude 프로필(<orca>/claude-profiles/<id>/home).
// Orca는 에이전트를 띄울 때 CLAUDE_CONFIG_DIR을 프로필 폴더로 넣고, ~/.claude를 원본으로 폴더는 링크, 파일은 복사한다.
// plugins와 skills 폴더는 프로필이 ~/.claude 것을 링크로 같이 쓰고, settings.json(enabledPlugins)은 폴더마다 따로다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.dirname(HARNESS);
export const MARKET = 'harness';

export function orcaDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'orca');
  // macOS, Linux 위치는 Electron 기본값으로 둔 추측이다 (미검증).
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'orca');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'orca');
}

// env가 null이면 CLAUDE_CONFIG_DIR을 넣지 않는다. ~/.claude에 이 값을 넣으면 ~/.claude.json 대신
// ~/.claude/.claude.json을 읽어 다른 설정이 되기 때문이다.
export function claudeConfigs() {
  const list = [{ name: 'main', dir: path.join(os.homedir(), '.claude'), env: null }];
  const base = path.join(orcaDataDir(), 'claude-profiles');
  if (fs.existsSync(base)) {
    for (const id of fs.readdirSync(base)) {
      const home = path.join(base, id, 'home');
      if (fs.existsSync(path.join(home, 'settings.json'))) list.push({ name: `orca-${id.slice(0, 4)}`, dir: home, env: home });
    }
  }
  return list;
}

export function codexHomes() {
  return [path.join(os.homedir(), '.codex'), path.join(orcaDataDir(), 'codex-runtime-home', 'home')]
    .filter((d) => fs.existsSync(d));
}

// claude CLI를 돌리고 마지막 JSON 값을 돌려준다. --json 출력 앞에 경고 줄이 섞일 수 있어 끝에서부터 찾는다.
export function claude(args, { config = null, cwd = undefined } = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  if (config?.env) env.CLAUDE_CONFIG_DIR = config.env;
  const r = spawnSync('claude', args, { env, cwd, encoding: 'utf8', timeout: 180000 });
  // 띄우지 못한 것(PATH에 없음, 시간 초과)을 "목록이 비었다"로 읽으면 호출하는 쪽이 없는 것으로 알고 잘못 만든다
  if (r.error) throw new Error(`claude ${args.slice(0, 2).join(' ')}를 실행하지 못했다: ${r.error.code || r.error.message}`);
  const out = (r.stdout || '').trim();
  let json = null;
  try { json = JSON.parse(out); } catch {
    const lines = out.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && json === null; i--) {
      try { json = JSON.parse(lines.slice(i).join('\n')); } catch { /* 계속 */ }
    }
  }
  return { status: r.status, json, stdout: out, stderr: (r.stderr || '').trim() };
}

export function readJson(file, fallback) {
  if (fallback !== undefined && !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function marketplacePlugins() {
  return readJson(path.join(HARNESS, '.claude-plugin', 'marketplace.json')).plugins;
}
