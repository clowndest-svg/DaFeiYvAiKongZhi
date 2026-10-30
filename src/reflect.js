import {
  addEvent,
  addMemory,
  getRecentMessages,
  kvGet,
  kvSet,
  listMemories,
  updateMessageMeta,
} from './db.js';
import { applyMood, getMood } from './mood.js';
import { noteBrainLink } from './brain.js';
import { applyNeuroEvent } from './neuro.js';
import { addSense } from './senses.js';
import { addIntention } from './intentions.js';
import { buildReflectionPrompt } from './prompt.js';
import { logger } from './logger.js';
import { costBlocked } from './budget.js';
import { clamp, parseJsonLoose, truncate } from './util.js';

let chain = Promise.resolve();

function squash(text) {
  return String(text || '').replace(/[\s，。！？、,.!?~～：:；;“”"'‘’（）()【】\[\]]/g, '');
}

export function scheduleReflection(ctx) {
  chain = chain
    .then(() => reflect(ctx))
    .catch((error) => logger.warn('事后反思失败', { error: error.message }));
  return chain;
}

export async function reflect({ llm, sessionId, assistantMessageId, settings, messages }) {
  if (!sessionId || costBlocked('reflect')) return null;
  const every = Math.max(1, Number(settings.model?.reflectEvery ?? 2));
  if (every > 1) {
    const turnKey = `reflect_turn:${sessionId}`;
    const turn = Number(kvGet(turnKey, '0') || 0) + 1;
    kvSet(turnKey, String(turn));
    if (turn % every !== 0) return null;
  }
  const throttleKey = `last_reflect_at:${sessionId}`;
  const last = kvGet(throttleKey);
  if (last && Date.now() - new Date(last).getTime() < 2500) return null;
  kvSet(throttleKey, new Date().toISOString());

  const recent = (messages || getRecentMessages(sessionId, 8)).slice(-8).filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.meta?.aborted && ['web', 'qq'].includes(m.channel || 'web'));
  if (recent.length < 2) return null;
  const name = settings.companion?.name || '小知';
  const transcript = recent
    .map((m) => `${m.role === 'user' ? '他' : name}：${truncate(m.content, 500)}`)
    .join('\n');
  const userSaid = squash(recent.filter((m) => m.role === 'user').map((m) => m.content).join(''));
  const mood = getMood();
  const core = listMemories({ layer: 'core', limit: 20 });

  const result = await llm.chat(
    [
      {
        role: 'system',
        content: '你是记忆整理器，只输出严格 JSON。不要输出 markdown，不要解释。',
      },
      {
        role: 'user',
        content: buildReflectionPrompt({ settings, mood, transcript, coreMemories: core }),
      },
    ],
    {
      kind: 'reflect',
      sessionId,
      temperature: 0.25,
      maxTokens: Math.min(500, Math.max(200, Number(settings.model.reflectMaxTokens || 450))),
      reasoningEffort: 'low',
      responseFormat: { type: 'json_object' },
      mockKind: 'reflect',
    },
  );

  let data;
  try {
    data = parseJsonLoose(result.content);
  } catch (error) {
    logger.warn('反思返回不是合法 JSON', { error: error.message, content: truncate(result.content, 200) });
    addEvent('reflect_error', '这一次的内心整理没有解析成功（已跳过，不影响聊天）');
    return null;
  }

  const innerThought = String(data.inner_thought || '').trim().slice(0, 300);
  if (innerThought && assistantMessageId) {
    updateMessageMeta(assistantMessageId, { innerThought });
  }

  const moodUpdate = data.mood || {};
  if (Number.isFinite(Number(moodUpdate.valence)) || Number.isFinite(Number(moodUpdate.energy))) {
    const applied = applyMood(
      {
        valence: Number(moodUpdate.valence),
        energy: Number(moodUpdate.energy),
        affection_delta: clamp(Number(moodUpdate.affection_delta) || 0, -3, 3),
        reason: String(moodUpdate.reason || '').slice(0, 120),
      },
      { sessionId },
    );
    const delta = Number(applied?.valence) - Number(mood.valence);
    if (delta >= 0.05) applyNeuroEvent('mood_up');
    else if (delta <= -0.05) applyNeuroEvent('mood_down');
  }

  const added = [];
  const memories = Array.isArray(data.memories) ? data.memories.slice(0, 2) : [];
  for (const item of memories) {
    const content = String(item?.content || '').trim();
    if (content.length < 4) continue;
    const row = addMemory({
      layer: 'mid',
      content: content.slice(0, 300),
      importance: clamp(Number(item.importance) || 3, 1, 5),
      tags: Array.isArray(item.tags) ? item.tags.map((t) => String(t).slice(0, 12)).slice(0, 5) : [],
      reasoning: String(item.reasoning || '').slice(0, 160),
      sourceSession: sessionId,
    });
    if (row) added.push(row);
  }

  const profileUpdates = Array.isArray(data.profile_updates) ? data.profile_updates.slice(0, 1) : [];
  for (const item of profileUpdates) {
    const content = String(item?.content || '').trim();
    if (content.length < 3) continue;
    const evidence = String(item?.evidence || '').trim();
    const normalized = squash(evidence);
    const source = recent.find((message) => message.role === 'user' && squash(message.content).includes(normalized));
    if (normalized.length < 3 || !source) {
      addEvent('reflect_profile_rejected', '这次反思想把一句没被他说过的话记成事实，已拒绝', {
        content: content.slice(0, 60),
        evidence: evidence.slice(0, 40),
      });
      continue;
    }
    const duplicate = core.some((m) => {
      const old = squash(m.content);
      const next = squash(content);
      return old.includes(next) || next.includes(old);
    });
    if (duplicate) continue;
    const row = addMemory({
      layer: 'core',
      content: content.slice(0, 300),
      importance: 5,
      tags: ['核心档案', '自动'],
      reasoning: `消息 ${source.id || '本轮'} 里他说过「${evidence.slice(0, 80)}」`,
      sourceSession: sessionId,
    });
    if (row) added.push(row);
  }

  const intentions = Array.isArray(data.intentions) ? data.intentions.slice(0, 1) : [];
  let intentionAdded = 0;
  for (const item of intentions) {
    const text = String(item?.text || item?.content || '').trim();
    if (text.length < 4) continue;
    if (addIntention({
      text,
      reason: String(item?.why || item?.reason || '').trim(),
      dueInHours: clamp(Number(item?.later_hours ?? item?.dueInHours ?? 2) || 2, 0, 72),
    })) intentionAdded += 1;
  }

  let senseAdded = 0;
  if (settings.presence?.sensesEnabled) {
    const senses = Array.isArray(data.senses) ? data.senses.slice(0, 1) : [];
    for (const item of senses) {
      const content = String(item?.text || '').trim();
      if (content.length < 2) continue;
      const evidence = String(item?.evidence || '').trim();
      const normalized = squash(evidence);
      const source = recent.find((message) => message.role === 'user' && normalized.length >= 3 && squash(message.content).includes(normalized));
      const result = addSense({
        kind: item?.kind,
        text: content,
        detail: item?.detail,
        evidence,
        sourceText: source?.content || '',
        source: 'reflect',
      });
      if (result.ok) {
        senseAdded += 1;
        noteBrainLink('sense');
      }
    }
  }

  if (added.length) {
    logger.info('写入新记忆', { count: added.length, sessionId });
    noteBrainLink('reflect', added.length);
  }
  return { innerThought, added: added.length, intentions: intentionAdded, senses: senseAdded };
}
