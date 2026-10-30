import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwnedProcess } from '../src/processes.js';
import { ROOT } from '../src/config.js';
import path from 'node:path';
test('停止只匹配本项目可执行文件和入口，不匹配其他 Node 或 NapCat',()=>{
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:'C:/other/NapCatWinBootMain.exe'},'napcat'),false);
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:path.join(ROOT,'napcat','NapCatWinBootMain.exe')},'napcat'),true);
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:process.execPath,CommandLine:'node C:/other/index.js'},'server'),false);
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:process.execPath,CommandLine:'node "C:/other/index.js" --note "'+path.join(ROOT,'src','index.js')+'"'},'server'),false);
 assert.equal(isOwnedProcess({ProcessId:1,ExecutablePath:process.execPath,CommandLine:'node "'+path.join(ROOT,'src','index.js')+'"'},'server'),true);
});
