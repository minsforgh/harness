// 새 Unity 프로젝트를 공식 CLI로 만든다. apply.mjs --new가 묶음 목록에 unity가 있을 때 부른다(묶음마다 new-project.mjs).
//   unity projects create <이름> --path <부모> --editor-version <버전> --template <2d|3d|id> --no-cloud --non-interactive
// 기본 scaffolding이 com.unity.pipeline(0.10 이상)을 넣고 에디터를 한 번 돌려 Library까지 만든다(6000.3.27f1, CLI beta.17에서 3분쯤).
// 고칠 점: com.unity.collab-proxy를 manifest와 lock에서 뺀다(Unity Version Control 창이 뜬다. 옛 POC-Template도 뺐다).
//         URPProjectSettings.asset의 재질 버전이 낮으면 지운다(아래 staleUrpSettings).
// 에디터 버전: 주지 않으면 설치된 것 중 가장 높은 정식(f) 버전. CLI 기본값에 맡기면 알파나 베타가 골라질 수 있다.
// 시험은 HARNESS_UNITY_CLI(node로 돌릴 .mjs 경로)로 가짜 CLI를 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DROP = ['com.unity.collab-proxy'];

function cli(args, timeout = 120000) {
  const fake = process.env.HARNESS_UNITY_CLI;
  const r = fake
    ? spawnSync(process.execPath, [fake, ...args], { encoding: 'utf8', timeout })
    : spawnSync('unity', args, { encoding: 'utf8', timeout });
  if (r.error) throw new Error(`unity ${args.slice(0, 2).join(' ')}를 실행하지 못했다: ${r.error.code || r.error.message}`);
  return r;
}

const parts = (v) => v.match(/\d+/g).map(Number);
function newer(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** 설치된(location이 있는) 정식 버전 중 가장 높은 것. */
export function pickEditor(items) {
  const stable = items.filter((e) => e.location && /^\d+\.\d+\.\d+f\d+$/.test(e.version)).map((e) => e.version);
  return stable.reduce((best, v) => (!best || newer(v, best) ? v : best), null);
}

/** manifest와 lock의 dependencies에서 뺄 패키지를 지운다. 바뀐 파일 이름을 돌려준다. */
export function dropPackages(project) {
  const changed = [];
  for (const name of ['manifest.json', 'packages-lock.json']) {
    const file = path.join(project, 'Packages', name);
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const deps = json.dependencies || {};
    const gone = DROP.filter((p) => p in deps);
    if (!gone.length) continue;
    for (const p of gone) delete deps[p];
    // Unity가 쓰는 모양(두 칸 들여쓰기, 끝 줄바꿈)과 같게 써서 처음 열 때 diff가 생기지 않게 한다
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
    changed.push(`${name}(${gone.join(', ')})`);
  }
  return changed;
}

/**
 * 템플릿의 URP 재질 버전이 URP 17.3의 갱신 단계(10)보다 낮으면 그 파일을 지운다. 파일이 있고 버전이 다르면 URP가 모달 대화창을 띄우고,
 * 없으면 대화창 없이 갱신하고 다시 만든다(CLI beta.14에서 겪음, beta.17 scaffolding은 이미 10이었다). 지웠으면 true.
 */
export function staleUrpSettings(project, expected = 10) {
  const file = path.join(project, 'ProjectSettings', 'URPProjectSettings.asset');
  if (!fs.existsSync(file)) return false;
  const m = fs.readFileSync(file, 'utf8').match(/m_LastMaterialVersion:\s*(\d+)/);
  if (!m || Number(m[1]) >= expected) return false;
  fs.rmSync(file);
  return true;
}

export function createProject({ target, version, template = '2d', note }) {
  let editor = version;
  if (!editor) {
    const r = cli(['editors', '--json']);
    let items = [];
    try { items = JSON.parse(r.stdout).data.items || []; } catch { throw new Error(`unity editors --json을 읽지 못했다: ${r.stdout || r.stderr}`); }
    editor = pickEditor(items);
    if (!editor) throw new Error('설치된 정식(f) 에디터가 없다. --unity <버전>을 주거나 Unity Hub로 설치한다.');
  }
  note(`Unity 프로젝트 만드는 중: ${editor}, 템플릿 ${template} (몇 분 걸린다)`);
  const r = cli(['projects', 'create', path.basename(target), '--path', path.dirname(target), '--editor-version', editor,
    '--template', template, '--no-cloud', '--non-interactive'], 20 * 60 * 1000);
  if (r.status !== 0 || !fs.existsSync(path.join(target, 'Packages', 'manifest.json'))) {
    throw new Error(`unity projects create 실패(종료 ${r.status}): ${(r.stdout + r.stderr).trim().slice(-800)}`);
  }
  const dropped = dropPackages(target);
  if (dropped.length) note(`패키지 뺌: ${dropped.join(', ')}`);
  if (staleUrpSettings(target)) note('URPProjectSettings.asset 지움(재질 버전이 낮아 처음 Play에서 갱신 대화창이 에디터를 멈춘다. 다음에 열 때 URP가 다시 만든다)');
  const deps = JSON.parse(fs.readFileSync(path.join(target, 'Packages', 'manifest.json'), 'utf8')).dependencies || {};
  note(`Unity 프로젝트 만듦: ${target} (${editor}, com.unity.pipeline ${deps['com.unity.pipeline'] || '없음'}, Unity Hub에 등록됨)`);
  return { editor };
}
