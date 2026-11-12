import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { paths, env } from './config.js';
import { addEvent } from './db.js';

const allowed = /^(?:(?:src|tools|tests)\/.*\.(?:js|mjs|cjs|py|ps1)|web\/.*\.(?:js|css|html)|config\/(?:persona|mom-letter)\.md|config\/default-settings\.json|package(?:-lock)?\.json|README\.md|docs\/.*\.md)$/;
const digest = text => createHash('sha256').update(text).digest('hex');

export function resolveSourceFile(input) {
  const relative = String(input || '').replaceAll('\\', '/');
  if (!allowed.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('只可访问项目 src、web、公开文档和默认配置，私密配置与数据目录不可访问');
  const file = path.resolve(paths.root, relative);
  const real = fs.realpathSync(file);
  if (real !== file && real.toLowerCase() !== file.toLowerCase()) throw new Error('源码路径经过了链接，停止访问');
  if (!fs.statSync(real).isFile() || fs.statSync(real).size > 512 * 1024) throw new Error('文件不是普通文本或超过 512 KB');
  return { file: real, relative };
}

export function listSourceFiles() {
  const found = [];
  for (const dir of ['src', 'tools', 'tests', 'web', 'config', 'docs']) {
    for (const item of fs.readdirSync(path.join(paths.root, dir), { recursive: true, withFileTypes: true })) {
      if (!item.isFile()) continue;
      const relative = path.relative(paths.root, path.join(item.parentPath, item.name)).replaceAll('\\', '/');
      if (allowed.test(relative)) found.push(relative);
    }
  }
  return ['README.md', 'package.json', 'package-lock.json', ...found].sort();
}

export function readSourceFile({ path: input, startLine = 1, lineCount = 100 }) {
  const { file, relative } = resolveSourceFile(input);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Math.trunc(Number(startLine) || 1));
  const count = Math.max(1, Math.min(160, Math.trunc(Number(lineCount) || 100)));
  return { path: relative, hash: digest(content), totalLines: lines.length, startLine: start, text: lines.slice(start - 1, start - 1 + count).join('\n').slice(0, 16000) };
}

function syntaxCheck(file, content) {
  if (/\.(?:js|mjs|cjs|json)$/.test(file)) {
    if (file.endsWith('.json')) { JSON.parse(content); return; }
    const checked = spawnSync(process.execPath, ['--check', file.endsWith('.cjs') ? '--input-type=commonjs' : '--input-type=module'], { input: content, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (checked.error || checked.status !== 0) throw new Error(`语法检查失败，文件未修改：${String(checked.stderr || checked.error?.message).slice(0, 1500)}`);
  }
  if (file.endsWith('.py')) {
    const checked = spawnSync(env.edgePython || 'python', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: content.replace(/^\uFEFF/, ''), encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (checked.error || checked.status !== 0) throw new Error(`Python 语法检查失败，文件未修改：${String(checked.stderr || checked.error?.message).slice(0, 1500)}`);
  }
  if (file.endsWith('.ps1')) {
    const script = '[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); $t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$t,[ref]$e); if($e.Count){$e | ForEach-Object {$_.Message}; exit 1}';
    const checked = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { input: content, encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, PSModulePath: undefined } });
    if (checked.error || checked.status !== 0) throw new Error(`PowerShell 语法检查失败，文件未修改：${String(checked.stdout || checked.stderr || checked.error?.message).slice(0, 1500)}`);
  }
}

export function replaceSourceText({ path: input, oldText, newText, expectedHash }) {
  const { file, relative } = resolveSourceFile(input);
  if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string' || !expectedHash) throw new Error('修改必须提供刚读取的文件哈希、唯一原文和替换文字');
  const before = fs.readFileSync(file, 'utf8');
  if (digest(before) !== expectedHash) throw new Error('文件在读取后发生变化，请重新读取再修改');
  if (before.split(oldText).length !== 2) throw new Error('原文必须在文件中唯一匹配，请扩大匹配范围');
  const after = before.replace(oldText, () => newText);
  return writeSourceVersion(file, relative, before, after);
}

function writeSourceVersion(file, relative, before, after) {
  if (file.endsWith('.ps1') && before.startsWith('\uFEFF') && !after.startsWith('\uFEFF')) after = '\uFEFF' + after;
  if (Buffer.byteLength(after) > 512 * 1024) throw new Error('修改后文件超过 512 KB');
  syntaxCheck(file, after);
  if (fs.readFileSync(file, 'utf8') !== before) throw new Error('语法检查期间文件发生变化，请重新读取再修改');
  const id = randomUUID();
  const dir = path.join(paths.data, 'source-edits');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ path: relative, before, afterHash: digest(after), at: new Date().toISOString() }), { flag: 'wx' });
  const temp = `${file}.${id}.tmp`;
  try { fs.writeFileSync(temp, after, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  addEvent('source_edit', '她修改了项目源码', { path: relative, editId: id });
  return { ok: true, path: relative, editId: id, hash: digest(after), restartRequired: relative.startsWith('src/') };
}

export function restoreSourceEdit({ editId }) {
  if (!/^[0-9a-f-]{36}$/.test(String(editId))) throw new Error('修改记录 ID 不合法');
  const record = JSON.parse(fs.readFileSync(path.join(paths.data, 'source-edits', `${editId}.json`), 'utf8'));
  const { file, relative } = resolveSourceFile(record.path);
  const current = fs.readFileSync(file, 'utf8');
  if (digest(current) !== record.afterHash) throw new Error('文件在这次修改后又变过，请读取后逐项恢复');
  return writeSourceVersion(file, relative, current, record.before);
}
