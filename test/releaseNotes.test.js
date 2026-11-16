'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerReleaseNotes, isNewVersion } = require('../src/releaseNotes');

test('版本判断支持跨版本升级，不把重载或降级当成更新', () => {
  assert.equal(isNewVersion(undefined, '0.3.0'), true);
  assert.equal(isNewVersion('0.1.2', '0.3.0'), true);
  assert.equal(isNewVersion('0.9.0', '0.10.0'), true);
  assert.equal(isNewVersion('0.3.0', '0.3.0'), false);
  assert.equal(isNewVersion('0.4.0', '0.3.0'), false);
});

async function setup(previous, focused = true, fail = false, packaged = false) {
  const calls = [], commands = new Map(), saved = new Map(previous ? [['releaseNotesVersion', previous]] : []);
  const callbacks = [], subscriptions = [];
  const disposable = { dispose() {} };
  const vscode = {
    Uri: { joinPath: (_uri, name) => name },
    workspace: { fs: { stat: async uri => { if (packaged && uri === 'CHANGELOG.md') throw { code: 'FileNotFound' }; } } },
    window: { state: { focused }, onDidChangeWindowState: callback => { callbacks.push(callback); return disposable; } },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable; }, executeCommand: async (...args) => { if (fail) throw new Error('preview failed'); calls.push(args); } }
  };
  registerReleaseNotes(vscode, { extension: { packageJSON: { version: '0.3.0' } }, extensionUri: {}, subscriptions,
    globalState: { get: key => saved.get(key), update: async (key, value) => { saved.set(key, value); } }
  }, { appendLine() {} });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, commands, saved, focus: async () => {
    vscode.window.state.focused = true; callbacks.forEach(callback => callback({ focused: true }));
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test('升级自动展示完整更新记录，后续聚焦不重复展示', async () => {
  const app = await setup('0.2.0');
  assert.deepEqual(app.calls, [['markdown.showPreview', 'CHANGELOG.md']]);
  assert.equal(app.saved.get('releaseNotesVersion'), '0.3.0');
  await app.focus(); assert.equal(app.calls.length, 1);
});
test('同版重载不自动展示，用户仍能主动查看', async () => {
  const app = await setup('0.3.0'); assert.equal(app.calls.length, 0);
  await app.commands.get('gitDaily.showReleaseNotes')(); assert.equal(app.calls.length, 1);
});
test('安装包小写更新记录在区分文件名大小写的系统上也能打开', async () => {
  const app = await setup('0.2.0', true, false, true);
  assert.deepEqual(app.calls, [['markdown.showPreview', 'changelog.md']]);
});
test('后台升级延后到前台再展示，打开失败不消耗展示记录', async () => {
  const app = await setup('0.2.0', false); assert.equal(app.calls.length, 0);
  await app.focus(); assert.equal(app.calls.length, 1);
  const failed = await setup('0.2.0', true, true);
  assert.equal(failed.saved.get('releaseNotesVersion'), '0.2.0');
});
