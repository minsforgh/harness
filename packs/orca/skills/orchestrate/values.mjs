// AGENTS.md "값" 표 읽기(harness-orca). route-worker와 milestone-check가 같이 쓰고, hooks/inject.py가 같은 규칙을 파이썬으로 따른다.
// - "값" 절(## 값, ### 값, ## 값 (설명)) 안의 표만 읽는다. 다음 같은 급 이상 제목에서 끝난다(apply.mjs와 같다).
// - 칸은 이스케이프하지 않은 |로 나눈다. 첫 칸이 이름, 둘째 칸이 값이고 뒤 칸(설명 등)은 읽지 않는다.
// - 이름과 값의 백틱과 굵게 표시는 벗긴다. 값이 비었거나 <로 시작하면 빈 값이다(틀의 자리표시).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEPARATOR = /^:?-+:?$/;
const strip = (v) => v.replace(/^[`*_]+|[`*_]+$/g, '').trim();

export function cells(line) {
  const parts = line.trim().split(/(?<!\\)\|/);
  if (parts.length && !parts[parts.length - 1].trim()) parts.pop();
  return parts.slice(1).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const isSeparator = (c) => c.length > 0 && c.every((x) => SEPARATOR.test(x));

// 표의 행(머리 행과 구분 행 제외) -> [{ name, value }]
export function tableRows(lines) {
  const rows = [];
  lines.forEach((line, i) => {
    if (!line.trimStart().startsWith('|')) return;
    const c = cells(line);
    if (c.length < 2 || isSeparator(c)) return;
    const next = lines[i + 1];
    if (next?.trimStart().startsWith('|') && isSeparator(cells(next))) return;
    rows.push({ name: strip(c[0]).replace(/\s+/g, ' '), value: strip(c[1]) });
  });
  return rows;
}

export function valueSection(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{2,3}\s+값(\s|$)/.test(l));
  if (at < 0) return [];
  const depth = lines[at].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > at && new RegExp(`^#{1,${depth}}\\s`).test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end);
}

// "값" 절의 행. 같은 이름이 둘 이상이면 첫 행을 쓰고 duplicates에 남긴다.
export function readValueRows(text) {
  const rows = new Map(), duplicates = [];
  for (const { name, value } of tableRows(valueSection(text))) {
    if (rows.has(name)) duplicates.push(name);
    else rows.set(name, value);
  }
  return { rows, duplicates };
}

// 'missing'(행 없음), 'empty'(비었거나 자리표시), 'skip-no-reason', 'skipped'("생략: 이유"), 'set'
export function valueState(value) {
  if (value == null) return 'missing';
  if (!value || value.startsWith('<')) return 'empty';
  if (/^생략\s*(:\s*)?$/.test(value)) return 'skip-no-reason';
  if (/^생략\s*:/.test(value)) return 'skipped';
  return 'set';
}

// 이 묶음이 넣는 행 이름(values.md). 오케스트레이션 전에 모두 채우거나 "생략: 이유"를 쓴다.
export const ORCA_ROWS = tableRows(readFileSync(fileURLToPath(new URL('../../values.md', import.meta.url)), 'utf8')
  .split(/\r?\n/)).map((r) => r.name);
