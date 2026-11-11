#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const settledStates = new Set(['succeeded', 'failed', 'stopped']);
const eventTypes = new Set(['worker_done', 'question', 'escalation']);
const retryCount = 3;

function argsOf(argv) {
  const options = { idleMin: 20, heartbeatMin: 15, intervalS: 20, once: false, follow: false, orca: 'orca' };
  const flags = { '--run': 'run', '--idle-min': 'idleMin', '--heartbeat-min': 'heartbeatMin', '--interval-s': 'intervalS', '--orca': 'orca', '--notify-deskpet': 'notifyDeskpet' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--once' || flag === '--follow') options[flag.slice(2)] = true;
    else if (flag === '--deskpet-attention') options.deskpetAttention = true;
    else if (flags[flag] && argv[i + 1]) options[flags[flag]] = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!options.run) throw new Error('Usage: node watch-workers.mjs --run <runId> [--idle-min 20] [--heartbeat-min 15] [--interval-s 20] [--once] [--follow] [--orca <command>] [--notify-deskpet <command>] [--deskpet-attention]');
  for (const key of ['idleMin', 'heartbeatMin', 'intervalS']) {
    options[key] = Number(options[key]);
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`${key} must be positive`);
  }
  return options;
}

// Split a quoted command into argv, without invoking a shell. This handles an
// executable path (including spaces) or e.g. "node ./fake-orca.mjs" on Windows.
function commandOf(value) {
  const parts = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(part => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, a, b) => a ?? b));
  if (!parts?.length) throw new Error('Empty command');
  return parts;
}

function workerName(worker) {
  const worktree = worker?.resource?.worktreeId ?? worker?.projection?.workspace?.id;
  const path = worktree?.split('::').at(-1)?.replace(/[\\/]+$/, '');
  return worker?.worktreeName ?? worker?.name ?? path?.split(/[\\/]/).at(-1) ?? worker?.dispatchId ?? '알 수 없는 worker';
}

function notification(value, name) {
  const subject = String(value.reason ?? '').replace(/\s+/g, ' ').trim();
  const blockedReasons = {
    'update prompt: Update now': '업데이트 안내',
    'permission prompt': '권한 요청',
    'unsubmitted draft': '미제출 입력',
    'unsubmitted pasted content': '미제출 붙여넣기',
  };
  const detail = value.type === 'start-blocked' ? blockedReasons[subject] ?? subject : subject;
  const details = detail.length > 36 ? `${detail.slice(0, 35)}…` : detail;
  const worker = name ?? value.dispatchId ?? 'worker';
  const messages = {
    'limit-hit': ['alert', 'high', `${worker} 가 사용 한도에 걸렸어요${value.resetsAt ? `(리셋 ${new Date(value.resetsAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })})` : ''}`],
    'start-blocked': ['alert', 'high', `worker 가 시작에서 멈췄어요: ${worker} — ${details}`],
    question: ['waiting', 'high', `${worker} 에게 질문이 왔어요: ${details}`],
    escalation: ['waiting', 'high', `${worker} 가 도움을 요청했어요: ${details}`],
    idle: ['alert', 'high', `${worker} 가 오래 멈춰 있어요.`],
    'heartbeat-lost': ['alert', 'high', `${worker} 의 heartbeat 가 끊겼어요.`],
    'watcher-error': ['failed', 'urgent', `worker 감시 오류: ${details}`],
  };
  // DeskPet's Orca plugin already announces worker completion; avoid duplicate done/all-settled bubbles.
  const selected = messages[value.type];
  if (!selected) return null;
  const [voice, priority, message] = selected;
  return { voice, priority, text: message.slice(0, 80), key: `${value.type}:${value.dispatchId ?? 'unknown'}` };
}

function notifyDeskpet(command, value, name, attention = false) {
  const notice = notification(value, name);
  if (!notice) return Promise.resolve(null);
  const hold = attention && Boolean(value.dispatchId) && ['question', 'escalation', 'start-blocked'].includes(value.type);
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), 'event', '--text', notice.text, '--voice', notice.voice,
      '--source', 'orchestration', '--key', notice.key, '--priority', notice.priority, ...(hold ? ['--attention', 'hold'] : [])],
    { shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000 });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(hold ? notice.key : null) : reject(new Error(`exit ${code}`)));
  });
}

function resolveDeskpet(command, key) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), 'event', '--source', 'orchestration', '--key', key, '--attention', 'resolve'],
      { shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000 });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
}

function execOrca(command, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), 'orchestration', ...argv, '--json'], { shell: false, windowsHide: true });
    const chunks = [];
    const errors = [];
    let bytes = 0;
    child.stdout.on('data', chunk => { bytes += chunk.length; chunks.push(chunk); if (bytes > 64 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      const output = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(output); } catch { reject(new Error(`orca ${argv[0]} exited ${code}: ${Buffer.concat(errors).toString('utf8').trim() || output.slice(0, 300)}`)); return; }
      if (code !== 0 || parsed.ok === false) {
        const error = new Error(parsed.error?.message || `orca ${argv[0]} exited ${code}`);
        error.code = parsed.error?.code;
        reject(error);
      } else resolve(parsed.result ?? parsed);
    });
  });
}

async function call(command, argv) {
  let error;
  for (let attempt = 0; attempt < retryCount; attempt++) {
    try { return await execOrca(command, argv); } catch (caught) { error = caught; }
  }
  throw error;
}

function statePath(run) {
  return join(tmpdir(), `orca-watch-workers-${createHash('sha256').update(run).digest('hex').slice(0, 24)}.json`);
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { seen: [], workers: {}, initialized: false }; throw error; }
}

function terminalText(terminal) {
  return Array.isArray(terminal?.tail) ? terminal.tail.join('\n') : String(terminal?.tail ?? '');
}

function working(terminal) {
  const tail = terminalText(terminal);
  return /(?:[•●]\s*(?:Working|Running|Thinking)|\b(?:working|running|thinking)\s*\([^\n]{0,80}\)|\b(?:esc to interrupt|ctrl\+c to interrupt)\b)/i.test(tail);
}

function blockedReason(terminal, isWorking) {
  const tail = terminalText(terminal);
  if (/Update now/i.test(tail)) return 'update prompt: Update now';
  if (/Permission required|Allow once/i.test(tail)) return 'permission prompt';
  if (terminal?.draft && String(terminal.draft).trim()) return 'unsubmitted draft';
  if (/\[Pasted Content\]/i.test(tail) && !isWorking) return 'unsubmitted pasted content';
  return null;
}

function limitHit(terminal, now) {
  const tail = terminalText(terminal);
  // A remaining-budget warning such as "⚠ 5h limit: 42% left" is not exhaustion.
  const exhausted = /(?:you(?:'|’)?ve hit your usage limit|usage limit (?:reached|exceeded|hit)|rate limit(?:ed)?(?: (?:reached|exceeded|hit))?|5h limit:\s*0%|limit reached|quota exceeded|z\.ai[^\n]*(?:limit|quota)[^\n]*(?:reached|exceeded))/i.test(tail);
  if (!exhausted) return null;
  const reset = tail.match(/(?:reset(?:s|ting)?(?:\s+at|\s+in)?|try again (?:at|after))\s*[:：]?\s*(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?|\d{1,2}:\d\d(?:\s*[AP]M)?)/i)?.[1];
  let resetsAt = null;
  if (reset) {
    let time = Date.parse(reset);
    if (!Number.isFinite(time) && /^\d{1,2}:\d\d/i.test(reset)) {
      const match = reset.match(/^(\d{1,2}):(\d\d)(?:\s*([AP]M))?/i);
      const date = new Date(now);
      let hour = Number(match[1]);
      if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
      date.setHours(hour, Number(match[2]), 0, 0);
      if (date.getTime() < now) date.setDate(date.getDate() + 1);
      time = date.getTime();
    }
    if (Number.isFinite(time)) resetsAt = new Date(time).toISOString();
  }
  return { resetsAt };
}

function messageRows(result) {
  return Array.isArray(result.messages) ? result.messages : Array.isArray(result.delivery?.messages) ? result.delivery.messages : [];
}

function messagePayload(message) {
  if (typeof message.payload === 'string') {
    try {
      const parsed = JSON.parse(message.payload);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) ? message.payload : {};
}

function messageKind(message, payload = messagePayload(message)) { return message.type ?? message.messageType ?? payload.type; }
function messageId(message) { return message.id ?? message.messageId ?? message.deliveryId; }
function messageTime(message) { return Date.parse(message.at ?? message.created_at ?? message.createdAt ?? message.sentAt ?? '') || null; }

function event(type, worker, reason, now) {
  return { type, dispatchId: worker?.dispatchId ?? null, taskId: worker?.taskId ?? null, terminalHandle: worker?.agentTerminalHandle ?? worker?.resource?.terminalHandle ?? null, reason, at: new Date(now).toISOString() };
}

function workerSettled(worker) {
  return settledStates.has(worker.workerState) || settledStates.has(worker.projection?.outcome)
    || settledStates.has(worker.projection?.stage?.worker) || ['failed', 'stopped'].includes(worker.dispatchStatus);
}

function isLive(worker) {
  if (workerSettled(worker)) return false;
  return worker.projection?.liveness?.verdict === 'live' || worker.terminalState === 'active';
}

async function allWorkers(command, run) {
  const rows = [];
  let cursor;
  do {
    const result = await call(command, ['worker-list', '--run', run, '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])]);
    rows.push(...(result.workers ?? []));
    cursor = result.page?.hasMore ? result.page.nextCursor : null;
    if (result.page?.hasMore && !cursor) throw new Error('worker-list hasMore without nextCursor');
  } while (cursor);
  return rows;
}

async function poll(options, state, command, now) {
  const workers = await allWorkers(command, options.run);
  const live = workers.filter(isLive);
  let messages;
  let canResolve = true;
  try {
    // Orca's `orchestration check --help` says --peek returns only unread
    // messages *without marking them read*. We never pass --ack or --wait.
    messages = messageRows(await call(command, ['check', '--run', options.run, '--peek']));
  } catch (error) {
    // A worker terminal is fenced from another Run's coordinator inbox. For
    // an already settled Run, no worker can generate new messages; allow the
    // historical --once check to report all-settled without rebinding a Run.
    if (error.code === 'consumer_fenced' && live.length === 0 && workers.every(workerSettled)) { messages = []; canResolve = false; }
    else throw error;
  }

  const candidates = [];
  const open = new Set();
  const byDispatch = new Map(workers.map(worker => [worker.dispatchId, worker]));
  for (const message of messages) {
    const payload = messagePayload(message);
    const kind = messageKind(message, payload);
    const dispatchId = message.dispatchId ?? payload.dispatchId;
    if (dispatchId && ['question', 'escalation'].includes(kind)) open.add(`${kind}:${dispatchId}`);
    const worker = byDispatch.get(dispatchId) ?? { dispatchId, taskId: message.taskId ?? payload.taskId, agentTerminalHandle: message.terminalHandle ?? message.from_handle ?? message.from };
    if (kind === 'heartbeat') {
      if (dispatchId) (state.workers[dispatchId] ??= {}).heartbeatAt = Math.max(state.workers[dispatchId]?.heartbeatAt ?? 0, messageTime(message) ?? now);
    } else if (eventTypes.has(kind)) {
      const type = kind === 'worker_done' ? 'done' : kind;
      const key = type === 'done' && dispatchId ? `done:${dispatchId}` : `${type}:message:${messageId(message) ?? `${dispatchId}:${messageTime(message) ?? ''}`}`;
      const reason = type === 'done' ? message.subject ?? message.body ?? kind
        : [payload.question, message.body, message.subject].find(text => typeof text === 'string' && text.trim()) ?? kind;
      candidates.push([key, event(type, worker, reason, now)]);
    }
  }

  for (const worker of workers) {
    const id = worker.dispatchId;
    const previous = state.workers[id];
    state.workers[id] = { ...previous, name: workerName(worker) };
    if (workerSettled(worker)) {
      if (state.initialized && previous && !previous.settled) candidates.push([`done:${id}`, event('done', worker, `dispatch ${worker.projection?.outcome ?? worker.workerState ?? worker.dispatchStatus}`, now)]);
      state.workers[id] = { ...state.workers[id], settled: true };
      continue;
    }
    if (!isLive(worker)) continue;
    const terminal = (await call(command, ['worker-read', '--dispatch', id, '--source', 'terminal', '--limit', '15'])).terminal ?? {};
    const tail = terminalText(terminal);
    const digest = createHash('sha256').update(tail).digest('hex');
    const since = previous?.digest === digest ? previous.since ?? now : now;
    const active = working(terminal);
    const limit = limitHit(terminal, now);
    const blocked = blockedReason(terminal, active);
    if (blocked) open.add(`start-blocked:${id}`);
    state.workers[id] = { ...state.workers[id], settled: false, digest, since, heartbeatAt: previous?.heartbeatAt ?? now };
    if (limit) candidates.unshift([`limit-hit:${id}`, { ...event('limit-hit', worker, 'usage limit reached', now), agent: worker.agent ?? worker.launch?.effective?.agent ?? worker.launch?.requested?.agent ?? worker.projection?.agent ?? null, resetsAt: limit.resetsAt }]);
    else if (blocked) candidates.push([`start-blocked:${id}`, event('start-blocked', worker, blocked, now)]);
    else if (!active && now - since >= options.idleMin * 60_000) candidates.push([`idle:${id}`, event('idle', worker, `screen unchanged for ${options.idleMin} min`, now)]);
    if (now - state.workers[id].heartbeatAt >= options.heartbeatMin * 60_000) candidates.push([`heartbeat-lost:${id}`, event('heartbeat-lost', worker, `no heartbeat for ${options.heartbeatMin} min`, now)]);
  }
  state.initialized = true;
  if (!live.length && !messages.length) candidates.push(['all-settled', event('all-settled', null, 'no live workers or unread messages', now)]);
  return { candidates, open, canResolve };
}

async function main() {
  const options = argsOf(process.argv.slice(2));
  const command = commandOf(options.orca);
  const deskpet = options.notifyDeskpet ? commandOf(options.notifyDeskpet) : null;
  const path = statePath(options.run);
  const state = readState(path);
  state.seen ??= [];
  state.workers ??= {};
  if (options.deskpetAttention) state.held ??= {};
  const seen = new Set(state.seen);
  const nowValue = () => Number(process.env.ORCA_WATCH_NOW_MS) || Date.now();
  while (true) {
    let candidates;
    let open;
    let canResolve = false;
    try { ({ candidates, open, canResolve } = await poll(options, state, command, nowValue())); }
    catch (error) { candidates = [[`watcher-error:${error.code ?? error.message}`, event('watcher-error', null, `${error.code ? `${error.code}: ` : ''}${error.message}`, nowValue())]]; }
    const queued = new Set();
    const fresh = candidates.filter(([key]) => {
      if (seen.has(key) || queued.has(key)) return false;
      queued.add(key);
      return true;
    });
    for (const [key, value] of options.follow ? fresh : fresh.slice(0, 1)) {
      console.log(JSON.stringify(value));
      seen.add(key);
      if (deskpet) {
        try {
          const heldKey = await notifyDeskpet(deskpet, value, state.workers[value.dispatchId]?.name, options.deskpetAttention);
          if (heldKey) state.held[heldKey] = { type: value.type, dispatchId: value.dispatchId };
        }
        catch (error) { console.error(`deskpet notification failed: ${String(error.message).replace(/\s+/g, ' ')}`); }
      }
    }
    if (deskpet && options.deskpetAttention && canResolve) {
      for (const key of Object.keys(state.held)) {
        if (open.has(key)) continue;
        try { await resolveDeskpet(deskpet, key); delete state.held[key]; }
        catch (error) { console.error(`deskpet notification failed: ${String(error.message).replace(/\s+/g, ' ')}`); }
      }
    }
    state.seen = [...seen];
    writeFileSync(path, JSON.stringify(state));
    if (candidates.some(([, value]) => ['all-settled', 'watcher-error'].includes(value.type))) return;
    if (fresh.length && !options.follow) return;
    if (options.once) return;
    await new Promise(resolve => setTimeout(resolve, options.intervalS * 1000));
  }
}

main().catch(async error => {
  const value = event('watcher-error', null, error.message, Date.now());
  console.log(JSON.stringify(value));
  const index = process.argv.indexOf('--notify-deskpet');
  if (index !== -1 && process.argv[index + 1]) {
    try { await notifyDeskpet(commandOf(process.argv[index + 1]), value); }
    catch (notificationError) { console.error(`deskpet notification failed: ${String(notificationError.message).replace(/\s+/g, ' ')}`); }
  }
  process.exitCode = 0;
});
