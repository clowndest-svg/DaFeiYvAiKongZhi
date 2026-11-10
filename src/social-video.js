import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths, loadSettings } from './config.js';
import { getPost, updatePost, recentUserMessages, getDb, kvSetJson } from './db.js';
import { synthesizeSpeech } from './tts.js';
import { assertPublicContent } from './privacy.js';
import { logger } from './logger.js';

const runFile = promisify(execFile);
let busy = false;
const runtime = randomUUID();

export function socialVideoTasks() {
  return getDb().prepare("SELECT key,value FROM kv WHERE key GLOB 'social:video-task:*' ORDER BY key DESC LIMIT 30").all().flatMap(row => {
    let task;
    try { task = JSON.parse(row.value); } catch { return []; }
    if (task.state === 'running' && task.runtime !== runtime) {
      task = { ...task, state: 'interrupted', error: '制作进程已结束，请检查成片后重新制作' };
      kvSetJson(row.key, task);
    }
    const available = /^douyin-\d+-[a-f0-9-]+\.mp4$/.test(task.file || '') && fs.existsSync(path.join(paths.media, task.file));
    return [{ id: task.id, postId: task.postId, title: task.title, state: task.state, stage: task.stage,
      createdAt: task.createdAt, updatedAt: task.updatedAt, error: task.error || '', file: available ? task.file : null }];
  });
}

export function videoCaption(text) {
  return String(text).replace(/[\r\n\t]+/g, ' ').match(/.{1,16}/gu)?.join('\n') || '';
}

export async function renderSocialVideo(id) {
  if (busy) throw Object.assign(new Error('已有视频正在制作，请稍后重试'), { status: 409 });
  const post = getPost(id);
  if (!post || post.kind !== 'douyin') throw Object.assign(new Error('请选择抖音草稿'), { status: 404 });
  if (post.status !== 'approved') throw Object.assign(new Error('请先批准当前草稿'), { status: 409 });
  if (!post.content || post.content.length > 300) throw new Error('口播正文需要在 1–300 字内');
  const settings = loadSettings();
  const gate = assertPublicContent([post.title, post.content, ...(post.tags || [])].join(' '), { settings, hisMessages: recentUserMessages(60) });
  if (!gate.ok) throw new Error(`内容未通过公开检查：${gate.reason}`);
  const ffmpeg = process.env.BIZHI_FFMPEG || 'ffmpeg';
  busy = true;
  let work;
  let audio;
  const taskId = `${Date.now()}-${randomUUID()}`;
  const task = { id: taskId, postId: id, title: post.title, runtime, state: 'running', stage: '准备工具', createdAt: new Date().toISOString() };
  const saveTask = patch => {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    kvSetJson(`social:video-task:${taskId}`, task);
  };
  try {
    saveTask({});
    await runFile(ffmpeg, ['-version'], { windowsHide: true, timeout: 10000 });
    fs.mkdirSync(paths.media, { recursive: true });
    work = fs.mkdtempSync(path.join(paths.media, 'video-work-'));
    fs.writeFileSync(path.join(work, 'caption.txt'), videoCaption(post.content), 'utf8');
    const cfg = settings.tts || {};
    saveTask({ stage: '合成配音' });
    audio = await synthesizeSpeech(post.content, { voice: cfg.voice, rate: cfg.rate, pitch: cfg.pitch, volume: cfg.volume || '', maxChars: 300 });
    const font = process.platform === 'win32' ? "fontfile='C\\:/Windows/Fonts/msyh.ttc':" : '';
    const filter = `[2:v]scale=280:280[avatar];[0:v][avatar]overlay=(W-w)/2:100,drawtext=${font}textfile=caption.txt:expansion=none:fontcolor=white:fontsize=28:line_spacing=8:x=(w-text_w)/2:y=440[v]`;
    const resultFile = path.join(work, 'result.mp4');
    saveTask({ stage: '编码视频' });
    await runFile(ffmpeg, ['-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=0x191323:s=720x1280:r=24', '-i', audio.file,
      '-loop', '1', '-i', path.join(paths.assets, 'avatar.png'), '-filter_complex', filter, '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', '-t', '120', '-movflags', '+faststart', resultFile],
    { cwd: work, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    if (!fs.statSync(resultFile).size) throw new Error('视频输出为空');
    const current = getPost(id);
    if (!current || current.status !== 'approved' || current.content !== post.content) throw new Error('草稿状态已变化，请重新制作');
    const name = `douyin-${id}-${randomUUID()}.mp4`;
    const destination = path.join(paths.media, name);
    fs.renameSync(resultFile, destination);
    const db = getDb();
    let transaction = false;
    try {
      db.exec('BEGIN');
      transaction = true;
      const result = updatePost(id, { meta: { video: { file: name, createdAt: new Date().toISOString(), engine: audio.engine, fallbackReason: audio.fallbackReason || '', rvc: audio.rvc || null } } });
      saveTask({ state: 'completed', stage: '可预览', file: name });
      db.exec('COMMIT');
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) db.exec('ROLLBACK');
      fs.unlinkSync(destination);
      throw error;
    }
  } catch (error) {
    saveTask({ state: 'failed', error: '制作失败，请检查语音和视频工具后重试' });
    throw error;
  } finally {
    busy = false;
    for (const file of [audio?.file, work].filter(Boolean)) {
      try {
        const relative = path.relative(path.resolve(paths.media), path.resolve(file));
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('临时文件不在媒体目录内');
        fs.rmSync(file, { recursive: file === work, force: true });
      }
      catch (error) { logger.warn('视频临时文件清理失败', { error: String(error.message).slice(0, 160) }); }
    }
  }
}
