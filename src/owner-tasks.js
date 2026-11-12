import { kvGetJson, kvSetJson } from './db.js';

const INDEX = 'owner-task-index';
const active = new Map();
const key = id => `owner-tool-run:${id}`;
const now = () => new Date().toISOString();

export function ownerTask(id) {
  if (!/^[a-f0-9-]{20,64}$/.test(String(id || ''))) return null;
  return kvGetJson(key(id), null);
}

export function startOwnerTask(id, input, controller) {
  const at = now();
  const task = { id, state: 'running', phase: 'planning', text: String(input.text || '').slice(0, 20000), channel: input.channel || 'web', sessionId: input.sessionId || '', maxSteps: input.maxSteps, startedAt: at, updatedAt: at, at, steps: 0, receipts: [], attachments: [] };
  kvSetJson(key(id), task);
  active.set(id, controller);
  const ids = [id, ...kvGetJson(INDEX, []).filter(item => item !== id)];
  for (const oldId of ids.slice(60)) {
    const old = ownerTask(oldId);
    if (old && old.state !== 'running') kvSetJson(key(oldId), { state: old.state, at: old.at, context: '【工具执行回执】这条历史消息已经执行过，详细记录已归档。请先核对当前状态，不要重复修改或发送。' });
  }
  kvSetJson(INDEX, ids.slice(0, 60));
  return task;
}

export function updateOwnerTask(id, patch) {
  const task = ownerTask(id);
  if (!task) return null;
  const next = { ...task, ...patch, updatedAt: now() };
  kvSetJson(key(id), next);
  return next;
}

export function noteOwnerTaskStep(id, receipt) {
  const task = ownerTask(id);
  if (!task) return;
  const result = receipt.result || {};
  updateOwnerTask(id, { receipts: [...task.receipts, { tool: receipt.tool, ok: result.ok !== false, result: JSON.stringify(result).slice(0, 1800), at: now() }].slice(-30) });
}

export function releaseOwnerTask(id) { active.delete(id); }

export function cancelOwnerTask(id) {
  const task = ownerTask(id);
  if (!task) return { ok: false, reason: '任务不存在' };
  const controller = active.get(id);
  if (!controller) return { ok: false, state: task.state, reason: task.state === 'running' ? '任务所属进程已退出，请核对执行记录' : '任务已经结束' };
  updateOwnerTask(id, { phase: 'cancelling' });
  controller.abort(new DOMException('主人要求停止任务', 'AbortError'));
  return { ok: true, state: 'cancelling' };
}

export function listOwnerTasks({ limit = 12, detail = false } = {}) {
  return kvGetJson(INDEX, []).slice(0, Math.max(1, Math.min(60, limit))).map(ownerTask).filter(Boolean).map(task => {
    if (detail) return task;
    const last = task.receipts?.at(-1);
    return { id: task.id, text: task.text?.slice(0, 200), channel: task.channel, state: task.state, phase: task.phase, tool: task.tool || '', action: task.action || '', steps: task.steps, maxSteps: task.maxSteps, startedAt: task.startedAt, updatedAt: task.updatedAt, finishedAt: task.finishedAt || null, lastError: task.lastError || '', lastResult: last ? { tool: last.tool, ok: last.ok } : null };
  });
}

export function recoverOwnerTasks() {
  let count = 0;
  for (const id of kvGetJson(INDEX, [])) {
    const task = ownerTask(id);
    if (task?.state !== 'running' || active.has(id)) continue;
    updateOwnerTask(id, { state: 'interrupted', phase: 'stopped', finishedAt: now(), lastError: '服务曾中断，未确认的动作需要核对', context: task.context || `【工具执行回执】这条消息的执行进程已中断。已完成记录 ${JSON.stringify(task.receipts || [])}。最后执行 ${task.tool || '规划'}，结果可能未知，请先核对，不要重复执行修改、点击或发送。` });
    count++;
  }
  return count;
}
