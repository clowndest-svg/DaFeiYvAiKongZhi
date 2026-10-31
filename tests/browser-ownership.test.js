// 专用浏览器归属核实的判据。这个函数是"能不能接管这个 Chrome"的唯一闸门，
// 判错方向就是把主人日常浏览器当成自动化窗口来操作，所以正反样本都要钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ownsProfileDir, parseUserDataDir } from '../src/browser/cdp.js';

const PROFILE = path.resolve('D:/RuanJian/BiZhi/data/xhs-profile');

test('读得出 --user-data-dir，带引号、相对路径、大小写差异都算同一个目录', () => {
  assert.equal(parseUserDataDir(`chrome.exe --user-data-dir=${PROFILE}`), PROFILE);
  assert.equal(parseUserDataDir(`chrome.exe "--user-data-dir=${PROFILE}"`), PROFILE);
  assert.equal(parseUserDataDir('chrome.exe --user-data-dir=data/xhs-profile').toLowerCase().includes('xhs-profile'), true);
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=${PROFILE.toUpperCase()}`, PROFILE), true, 'Windows 路径大小写不同应当算同一个目录');
});

test('不是本项目专用目录就拒绝接管', () => {
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=C:/Users/me/AppData/Local/Google/Chrome/User Data`, PROFILE), false, '主人日常浏览器被当成自己的窗口');
  assert.equal(ownsProfileDir('chrome.exe --remote-debugging-port=9333', PROFILE), false, '没带数据目录参数不该算通过');
  assert.equal(ownsProfileDir('', PROFILE), false);
  assert.equal(ownsProfileDir(undefined, PROFILE), false);
});

test('前缀像但不是同一个目录的必须拒绝（data/xhs-profile-evil 不是 data/xhs-profile）', () => {
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=${PROFILE}-evil`, PROFILE), false);
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=${PROFILE}/sub`, PROFILE), false);
});

test('参数顺序与相邻参数不影响判定', () => {
  const line = `chrome.exe --enable-automation --user-data-dir=${PROFILE} --no-first-run --window-size=1280,900`;
  assert.equal(ownsProfileDir(line, PROFILE), true);
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=${path.resolve(PROFILE, '..')}`, PROFILE), false);
});
