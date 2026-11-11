// AGENTS.md harness-team 블록 만들기(원본: dev-wiki _harness/packs/team/agents-block.mjs).
// apply.mjs가 묶음 폴더에 이 파일이 있으면 build로 블록 글을 받아 <!-- harness-team:start --> ~ end 사이에 다시 쓴다.
// 팀원에게는 플러그인이 없어 core와 unity 규칙이 주입되지 않으므로, 그 규칙 중 저장소 층 줄을 AGENTS.md로 옮긴다(harness-design Q162).
// 무엇을 빼고 고치는지는 block.json에 있다. 원본 줄이 바뀌어 맞지 않으면 problems로 알린다(그 줄은 고치지 않고 둔다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const demote = (lines) => lines.filter((l) => !/^# /.test(l)).map((l) => (/^#{2,5} /.test(l) ? `#${l}` : l));

// dirOf(묶음 이름) -> 그 묶음 폴더(설치본이나 원본). 없으면 null
export function build({ dirOf, self = HERE }) {
  const spec = JSON.parse(read(path.join(self, 'block.json')));
  const problems = [];
  const parts = [demote(read(path.join(self, spec.head)).split('\n')).join('\n').trim()];
  for (const src of spec.sources) {
    const where = `harness-${src.pack} ${src.file}`;
    const dir = dirOf(src.pack);
    if (!dir || !fs.existsSync(path.join(dir, src.file))) {
      problems.push(`${where}: 이번 적용에 그 묶음이나 파일이 없어 블록에서 뺐다`);
      continue;
    }
    let text = read(path.join(dir, src.file));
    for (const [from, to] of src.edit || []) {
      const n = text.split(from).length - 1;
      if (n !== 1) problems.push(`${where}: 고칠 글이 ${n}번 맞아 그대로 두었다: ${from}`);
      else text = text.replace(from, () => to);
    }
    let lines = text.split('\n');
    for (const h of src.dropSections || []) {
      const at = lines.flatMap((l, i) => (l === h || l.startsWith(`${h} `) ? [i] : []));
      if (at.length !== 1) { problems.push(`${where}: 뺄 절이 ${at.length}번 맞아 그대로 두었다: ${h}`); continue; }
      const depth = h.match(/^#+/)[0].length;
      let end = lines.findIndex((l, j) => j > at[0] && new RegExp(`^#{1,${depth}}\\s`).test(l));
      if (end < 0) end = lines.length;
      lines.splice(at[0], end - at[0]);
    }
    for (const p of src.drop || []) {
      const n = lines.filter((l) => l.startsWith(p)).length;
      if (n !== 1) problems.push(`${where}: 뺄 줄이 ${n}번 맞아 그대로 두었다: ${p}`);
      else lines = lines.filter((l) => !l.startsWith(p));
    }
    parts.push(demote(lines).join('\n').trim());
  }
  const text = [
    '## 공통 규칙 (harness-team)',
    '',
    '> 하네스가 만든 블록이다(원본: PR 관리자의 dev-wiki `_harness/packs/` core, unity, team 규칙). 다시 적용할 때 덮어쓰므로 손으로 고치지 않는다.',
    '',
    parts.join('\n\n'),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, problems };
}

// text의 표식 사이를 inner로 바꾼다. 표식이 없으면 끝에 더한다. 표식이 하나만 있으면 null(고치지 않는다)
export function upsert(text, name, inner) {
  const start = `<!-- harness-${name}:start -->`;
  const end = `<!-- harness-${name}:end -->`;
  const block = `${start}\n${inner}\n${end}`;
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + end.length);
  if (a >= 0 || b >= 0) return null;
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}
