import {
  addEvent,
  addMemory,
  getRecentMessages,
  kvGet,
  kvSet,
  listMemories,
  updateMessageMeta,
  getDb, getSession, kvGetJson,
} from './db.js';
import { loadSettings } from './config.js';
import { queueReflection, claimReflection, finishReflection } from './reflection-work.js';
import { applyMood, getMood } from './mood.js';
import { noteBrainLink } from './brain.js';
import { applyNeuroEvent } from './neuro.js';
import { addSense } from './senses.js';
import { addIntention, listIntentions, completeIntention } from './intentions.js';
import { getHerSelfNotes, updateHerSelfNotes } from './self.js';
import { buildReflectionPrompt } from './prompt.js';
import { logger } from './logger.js';
import { costBlocked } from './budget.js';
import { clamp, parseJsonLoose, truncate, keywordSet, overlapScore } from './util.js';
import { LatestTaskQueue } from './serial.js';

const reflectionQueue = new LatestTaskQueue({ onError: error => logger.warn('事后反思失败', { error: error.message }) });
export function reflectionBusy() { return reflectionQueue.running || reflectionQueue.pending.size > 0; }

function squash(text) {
  return String(text || '').replace(/[\s，。！？、,.!?~～：:；;“”"'‘’（）()【】\[\]]/g, '');
}

export function scheduleReflection(ctx) {
  queueReflection(ctx.sessionId, ctx.assistantMessageId);
  return drainReflections(ctx.llm, ctx.settings)
    .catch(error => logger.warn('反思暂未入队，原话已保留', { error: error.message }));
}

export function drainReflections(llm, settings = loadSettings()) {
  return reflectionQueue.enqueue('durable-reflection', async () => {
    if (kvGetJson('qq_maintenance', false) || costBlocked('reflect')) return;
    const batch = claimReflection(settings);
    if (!batch) return;
    try {
      const result = await reflect({ llm, settings, sessionId: batch.sessionId, assistantMessageId: batch.messageId,
        messages: batch.messages, batched: true,
        requestId: `reflect:${batch.rows.map(row => row.message_id).join('-')}`,
        onApplied: () => finishReflection(batch, 'done') });
      if (!result) finishReflection(batch, 'failed', '模型结果未通过校验');
    } catch (error) {
      finishReflection(batch, error.code === 'REFLECTION_BUDGET' ? 'pending' : 'failed', error.code || 'REFLECTION_FAILED');
      if (error.code !== 'REFLECTION_BUDGET') logger.warn('后台整理待检查', { code: error.code || 'REFLECTION_FAILED' });
    }
  });
}

export async function reflect({ llm, sessionId, assistantMessageId, settings, messages, batched = false, requestId, onApplied }) {
  if (!sessionId || costBlocked('reflect')) return null;
  const every = Math.max(1, Number(settings.model?.reflectEvery ?? 2));
  if (!batched && every > 1) {
    const turnKey = `reflect_turn:${sessionId}`;
    const turn = Number(kvGet(turnKey, '0') || 0) + 1;
    kvSet(turnKey, String(turn));
    if (turn % every !== 0) return null;
  }
  const throttleKey = `last_reflect_at:${sessionId}`;
  const last = kvGet(throttleKey);
  if (!batched && last && Date.now() - new Date(last).getTime() < 2500) return null;
  kvSet(throttleKey, new Date().toISOString());

  const sourceMessages = messages || getRecentMessages(sessionId, 8);
  const recent = (batched ? sourceMessages : sourceMessages.slice(-8)).filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.meta?.aborted && (m.role !== 'assistant' || !['pending', 'unknown', 'failed', 'not_sent'].includes(m.meta?.qqDelivery)) && ['web', 'qq'].includes(m.channel || 'web'));
  if (recent.length < 2) return null;
  const name = settings.companion?.name || '小知';
  const transcript = recent
    .map((m) => `${m.role === 'user' ? '他' : name}：${batched ? m.content : truncate(m.content, 500)}`)
    .join('\n');
  const userSaid = squash(recent.filter((m) => m.role === 'user').map((m) => m.content).join(''));
  const mood = getMood();
  const core = listMemories({ layer: 'core', limit: 20 });
  const openIntentions = listIntentions({ limit: 12 });

  const result = await llm.chat(
    [
      {
        role: 'system',
        content: '你是记忆整理器，只输出严格 JSON。不要输出 markdown，不要解释。',
      },
      {
        role: 'user',
        content: buildReflectionPrompt({ settings, mood, transcript, coreMemories: core, openIntentions, selfNotes: getHerSelfNotes().text }),
      },
    ],
    {
      kind: 'reflect',
      sessionId,
      temperature: 0.25,
      maxTokens: Math.min(1600, Math.max(800, Number(settings.model.reflectMaxTokens || 1000))),
      requestId,
      reasoningEffort: 'low',
      responseFormat: { type: 'json_object' },
      mockKind: 'reflect',
    },
  );

  let data;
  try {
    data = parseJsonLoose(result.content);
  } catch (error) {
    logger.warn('反思返回不是合法 JSON', { error: error.message });
    addEvent('reflect_error', '这一次的内心整理没有解析成功（已跳过，不影响聊天）');
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const innerThought = String(data.inner_thought || '').trim().slice(0, 300);
    if (innerThought && assistantMessageId) {
      updateMessageMeta(assistantMessageId, { innerThought });
    }

    // 她自己改自己：只动她自写的档案层，底线规则和代码不在她能改的范围内。
    let selfUpdated = false;
    if (data.self_update && typeof data.self_update === 'object' && !Array.isArray(data.self_update)) {
      selfUpdated = Boolean(updateHerSelfNotes(data.self_update, { source: 'reflect', transaction: false }));
    }

    const moodUpdate = data.mood || {};
    if (getSession(sessionId)?.status === 'active' && (Number.isFinite(Number(moodUpdate.valence)) || Number.isFinite(Number(moodUpdate.energy)))) {
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
      const evidence = String(item?.evidence || '').trim();
      const normalized = squash(evidence);
      const source = recent.find((message) => message.role === 'user' && normalized.length >= 3 && String(message.content || '').includes(evidence));
      if (evidence.length > 280) continue;
      if (!source) {
        addEvent('reflect_memory_rejected', '没有主人原话依据的重点记忆已跳过');
        continue;
      }
      const row = addMemory({
        layer: 'mid',
        // 保留原话的主语、否定和时态，避免模型改写把第三人的经历归到主人身上。
        content: `他说：「${String(source.content).length <= 280 ? source.content : evidence}」`,
        importance: clamp(Number(item.importance) || 3, 1, 5),
        tags: Array.isArray(item.tags) ? item.tags.map((t) => String(t).slice(0, 12)).slice(0, 5) : [],
        reasoning: `消息 ${source.id || '本轮'} 原话「${evidence.slice(0, 100)}」；${String(item.reasoning || '').slice(0, 40)}`,
        sourceSession: sessionId,
        mergeSimilar: false,
      });
      if (row) added.push(row);
    }

    const profileUpdates = Array.isArray(data.profile_updates) ? data.profile_updates.slice(0, 1) : [];
    for (const item of profileUpdates) {
      const content = String(item?.content || '').trim();
      if (content.length < 3) continue;
      const evidence = String(item?.evidence || '').trim();
      const normalized = squash(evidence);
      const source = recent.find((message) => message.role === 'user' && String(message.content || '').includes(evidence));
      if (normalized.length < 3 || !source || evidence.length > 280) {
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
        content: `他说：「${String(source.content).length <= 280 ? source.content : evidence}」`,
        importance: 5,
        tags: ['核心档案', '自动'],
        reasoning: `消息 ${source.id || '本轮'} 里他说过「${evidence.slice(0, 80)}」`,
        sourceSession: sessionId,
        mergeSimilar: false,
      });
      if (row) added.push(row);
    }

    const intentions = Array.isArray(data.intentions) ? data.intentions.slice(0, 1) : [];
    for (const item of (Array.isArray(data.completed_intentions) ? data.completed_intentions : []).slice(0, 2)) {
      const evidence = squash(item?.evidence);
      const source = recent.find(m => m.role === 'user' && evidence.length >= 3 && squash(m.content).includes(evidence));
      const said = String(source?.content || '');
      const explicitDone = /做完了|办完了|完成了|结束了|已经完成|取消了|不用提醒|不需要再提醒/.test(said)
        && !/还没|没做|没有|如果|假如|明天|以后|了吗|[?？]|朋友|他说|她说/.test(said);
      const intention = openIntentions.find(i => i.id === item.id);
      if (source && explicitDone && intention && overlapScore(keywordSet(intention.text), said) >= 0.12) completeIntention(item.id, `主人原话：${String(item.evidence).slice(0, 45)}`);
    }
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
    onApplied?.();
    db.exec('COMMIT');
    return { innerThought, added: added.length, intentions: intentionAdded, senses: senseAdded, selfUpdated };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
