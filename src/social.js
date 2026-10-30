import { loadSettings } from './config.js';
import { addEvent, addPost, deletePost, getDb, getPost, listPosts, recentUserMessages, updatePost } from './db.js';
import { publishQzone, qzoneStatus } from './channels/qzone.js';
import { logger } from './logger.js';
import { getMood } from './mood.js';
import { buildCommentPrompt, buildPostPrompt } from './prompt.js';
import { assertPublicContent } from './privacy.js';
import { nowIso, parseJsonLoose, stripMarkdownLite, truncate } from './util.js';
import { beginEffect, finishEffect, failEffect, DeliveryUnknownError } from './effects.js';

export const PLATFORM_LABELS = { qzone: 'QQ 空间', xhs: '小红书', douyin: '抖音' };

export async function generatePost({ llm, kind = 'qzone' }) {
  if (!Object.hasOwn(PLATFORM_LABELS, kind)) throw new Error('不支持的平台');
  const settings = loadSettings();
  const mood = getMood();
  const messages = [
    { role: 'system', content: '你只输出合法的 JSON 对象，不要 markdown，不要解释。' },
    { role: 'user', content: buildPostPrompt({ settings, mood, block: { mid: [] }, kind }) },
  ];
  let data;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await llm.chat(messages, { kind: `post:${kind}`, model: settings.model.name, temperature: 0.95, maxTokens: 900, reasoningEffort: 'low', responseFormat: { type: 'json_object' }, mockKind: `post:${kind}` });
    try { data = parseJsonLoose(result.content); break; }
    catch (error) { if (attempt === 1) throw error; }
  }
  const content = stripMarkdownLite(String(data?.content || '')).trim().slice(0, 3000);
  if (!content) throw new Error('模型没有写出正文');
  const title = String(data.title || data.hook || '').trim().slice(0, 60);
  const tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 8) : [];
  const gate = assertPublicContent([title, content, ...tags].join(' '), { settings, hisMessages: recentUserMessages(60) });
  if (!gate.ok) {
    addEvent('post_blocked', '公开草稿包含私密信息，未保存', { reason: gate.reason });
    throw new Error(`这条不能公开写：${gate.reason}`);
  }
  const post = addPost({ kind, title, content, tags, status: 'draft', meta: { hook: String(data.hook || ''), mood: mood.label, generatedAt: nowIso(), aiGenerated: true } });
  addEvent('post', `她写了一条${PLATFORM_LABELS[kind]}草稿`, { postId: post.id });
  return post;
}

export async function generateComments({ llm, context, platform = 'douyin' }) {
  const settings = loadSettings();
  const result = await llm.chat([
    { role: 'system', content: '你只输出合法 JSON，不要 markdown。' },
    { role: 'user', content: buildCommentPrompt({ settings, context: truncate(context, 2500), platform }) },
  ], { kind: 'comments', model: settings.model.name, temperature: 0.9, maxTokens: 400, reasoningEffort: 'low', responseFormat: { type: 'json_object' }, mockKind: 'comments' });
  const data = parseJsonLoose(result.content);
  return (Array.isArray(data.comments) ? data.comments : []).map((text) => String(text).slice(0, 80)).filter((text) => assertPublicContent(text, { settings, hisMessages: recentUserMessages(60) }).ok).slice(0, 3);
}

export function listAllPosts(limit = 60) { return listPosts({ limit }); }

function conflict(message) { return Object.assign(new Error(message), { status: 409 }); }

export function approvePost(id) {
  const post = getPost(id);
  if (!post) throw new Error('动态不存在');
  if (post.status === 'approved') return post;
  if (post.status !== 'draft') throw conflict('这条动态不是待批准草稿，不能重复批准或重发');
  const updated = updatePost(id, { status: 'approved', approved_at: nowIso(), error: null });
  addEvent('post_approved', `你批准了一条${PLATFORM_LABELS[post.kind] || ''}动态`, { postId: id });
  return updated;
}

export function markPosted(id, { url = '', note = '', verified = false } = {}) {
  const post = getPost(id);
  if (!post) throw new Error('动态不存在');
  if (post.status === 'posted') return post;
  if (!['approved', 'unknown', 'publishing'].includes(post.status)) throw conflict('先批准草稿，再标记发布结果');
  if (post.status === 'publishing' && !verified) throw conflict('发送仍在进行，请等结果再标记');
  if (url && !/^https?:\/\//i.test(url)) throw new Error('动态地址只能使用 http/https');
  const updated = updatePost(id, { status: 'posted', posted_at: nowIso(), external_url: url || null, error: null, meta: { publishedNote: note, publicationVerified: verified } });
  addEvent('post_posted', verified ? '平台确认动态已发布' : '你手动确认动态已发布', { postId: id });
  return updated;
}

export function removePost(id) {
  if (!getPost(id)) throw new Error('动态不存在');
  deletePost(id);
}

export async function tryAutoPublish(post, { requireApproved = false } = {}) {
  const settings = loadSettings();
  if (!settings.social?.[`${post.kind}AutoPost`]) return { ok: false, reason: '没有开启自动发布' };
  if (post.kind !== 'qzone') return { ok: false, reason: '请使用小红书图文编辑器；抖音仅支持文案草稿' };
  const current = getPost(post.id);
  const candidate = current || post;
  const gate = assertPublicContent([candidate.title, candidate.content, ...(Array.isArray(candidate.tags) ? candidate.tags : [])].join(' '), { settings, hisMessages: recentUserMessages(60) });
  if (!gate.ok) {
    addEvent('post_blocked', '这条说说不能公开写', { reason: gate.reason, postId: post.id });
    return { ok: false, reason: `这条不能公开写：${gate.reason}` };
  }
  if (!current) return { ok: false, reason: '动态不存在' };
  if (current.status === 'posted') return { ok: true, post: current, already: true };
  if (['publishing', 'unknown'].includes(current.status)) throw new DeliveryUnknownError('上次发布仍在进行或结果未知，请先在平台核实');
  if (requireApproved && current.status !== 'approved') throw conflict('先批准这条草稿再发布');
  const qz = qzoneStatus();
  const bridge = (process.env.QZONE_BRIDGE_URL || '').trim();
  if (!qz.configured && !bridge) return { ok: false, reason: '还没有配置 QQ 空间 Cookie，已保留草稿' };
  const key = `effect:qzone:post:${post.id}`;
  const operation = beginEffect(key);
  if (!operation.started) return { ok: true, post: getPost(post.id), already: true };
  updatePost(post.id, { status: 'publishing', error: null });
  let delivered = false;
  try {
    let receipt;
    let url;
    if (qz.configured) {
      receipt = await publishQzone({ content: current.content });
      url = `https://user.qzone.qq.com/${qz.uin}/mood/${receipt.tid}`;
    } else {
      let response;
      try {
        response = await fetch(`${bridge.replace(/\/+$/, '')}/publish`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(process.env.QZONE_BRIDGE_TOKEN ? { Authorization: `Bearer ${process.env.QZONE_BRIDGE_TOKEN}` } : {}) }, body: JSON.stringify({ content: current.content, images: [] }), signal: AbortSignal.timeout(30000) });
      } catch (error) { throw new DeliveryUnknownError('桥接发送结果未知，请先核实', error); }
      if (!response.ok) throw new Error(`桥接返回 HTTP ${response.status}`);
      receipt = await response.json().catch(() => null);
      if (receipt?.ok !== true || !(receipt.tid || /^https?:\/\//.test(receipt.url || ''))) throw new DeliveryUnknownError('桥接没有提供可核实的发布凭据');
      url = receipt.url || '';
    }
    delivered = true;
    const db = getDb();
    db.exec('BEGIN');
    let updated;
    try {
      updated = markPosted(post.id, { url, note: qz.configured ? '内置 Qzone 发布' : '配置的发布桥', verified: true });
      finishEffect(key, receipt);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { ok: true, post: updated, tid: receipt.tid };
  } catch (original) {
    const error = delivered ? new DeliveryUnknownError('平台已接收，但本地记录没写完，请人工核实', original) : original;
    failEffect(key, error);
    const unknown = error.code === 'DELIVERY_UNKNOWN';
    updatePost(post.id, { status: unknown ? 'unknown' : 'approved', error: error.message });
    logger.warn('QQ 空间发布未完成', { postId: post.id, unknown, error: error.message });
    return { ok: false, uncertain: unknown, reason: error.message };
  }
}
