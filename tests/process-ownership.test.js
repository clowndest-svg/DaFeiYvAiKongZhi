import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwnedProcess } from '../src/processes.js';
import { ROOT } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
test('停止只匹配本项目可执行文件和入口，不匹配其他 Node 或 NapCat',()=>{
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:'C:/other/NapCatWinBootMain.exe'},'napcat'),false);
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:path.join(ROOT,'napcat','NapCatWinBootMain.exe')},'napcat'),true);
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:process.execPath,CommandLine:'node C:/other/index.js'},'server'),false);
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:process.execPath,CommandLine:'node "C:/other/index.js" --note "'+path.join(ROOT,'src','index.js')+'"'},'server'),false);
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:process.execPath,CommandLine:'node "'+path.join(ROOT,'src','index.js')+'"'},'server'),true);
});

// 这条判据是补的：上一版 startNapCat 用 detached:true 起 NapCat，Windows 上等于给它
// 一个"没有控制台"的环境，于是 QQ.exe 被系统另起了一个可见控制台窗口，长期杵在桌面上。
// 没有任何规定说"不许弹窗"，所以它悄悄跑了好几轮 —— 现在把它钉成契约。
test('NapCat 启动必须是隐藏控制台的非分离子进程，不许在桌面留下窗口', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'processes.js'), 'utf8');
  const start = source.indexOf('export async function startNapCat');
  assert.ok(start > 0, '找不到 startNapCat');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  const spawnAt = body.indexOf('spawn(exe,');
  assert.ok(spawnAt > 0, 'startNapCat 里找不到那处 spawn');
  const options = body.slice(spawnAt, body.indexOf('});', spawnAt));
  assert.match(options, /detached:\s*false/, 'NapCat 不能用 detached:true —— 那会让 QQ 自己新建一个可见控制台窗口');
  assert.match(options, /windowsHide:\s*true/, '必须 windowsHide:true，控制台要存在但不可见');
  assert.match(body, /child\.unref\(\)/, '不起 unref 会把主进程吊在 NapCat 上');
});
