'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/core');

async function setup(options = {}) {
  const commands = new Map(), calls = [], errors = [];
  const disposable = { dispose() {} };
  const event = () => disposable;
  const file = name => ({ uri: { fsPath: `/repo/${name}`, toString: () => `file:///repo/${name}` } });
  const repo = {
    rootUri: { fsPath: '/repo', toString: () => 'file:///repo' }, inputBox: { value: '' },
    state: { HEAD: { name: 'main', commit: 'abc', upstream: {} }, indexChanges: options.staged ? [file('a')] : [], workingTreeChanges: [file('a'), file('b')], untrackedChanges: [], mergeChanges: [], remotes: [{ name: 'origin' }], onDidChange: event },
    status: async () => {}, add: async paths => { calls.push(['add', paths]); },
    commit: async (message, opts) => { calls.push(['commit', message, opts]); if (options.commitError) throw new Error('hook rejected'); },
    push: async (...args) => calls.push(['push', ...args]),
    pull: async () => calls.push(['pull'])
  };
  let input = options.message === undefined ? 'feat: example' : options.message;
  const vscode = {
    EventEmitter: class { event = event; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class {},
    TreeItemCollapsibleState: { Expanded: 2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
    extensions: { getExtension: () => ({ activate: async () => ({ enabled: true, getAPI: () => ({ repositories: [repo], onDidOpenRepository: event, onDidCloseRepository: event }) }) }) },
    workspace: { isTrusted: true, getConfiguration: () => ({ enabled: false, get: (_key, value) => value }), onDidChangeConfiguration: event, saveAll: async () => options.save !== false },
    window: {
      state: { focused: true }, createOutputChannel: () => ({ ...disposable, appendLine() {}, show() {} }),
      createStatusBarItem: () => ({ ...disposable, show() {}, hide() {} }), registerTreeDataProvider: () => disposable,
      onDidChangeWindowState: event,
      showQuickPick: async (items, config) => config?.canPickMany ? (options.cancelFiles ? undefined : [items[0]]) : items[0],
      showInputBox: async () => typeof input === 'function' ? input() : input,
      showInformationMessage: async () => undefined,
      showErrorMessage: async message => { errors.push(message); },
      withProgress: async (_options, action) => action()
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable; }, executeCommand: async () => {} }
  };
  const context = { subscriptions: [], workspaceState: { get: () => ({}), update: async () => {} } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : name === './core' ? core : require(name),
    setInterval: () => 1, clearInterval() {}, Date, Set, Map
  });
  await module.exports.activate(context);
  return { repo, calls, errors, run: action => commands.get(`gitDaily.${action}`)(repo) };
}

test('选择文件提交：只暂存所选文件，并禁用提交后的隐式推送', async () => {
  const app = await setup(); await app.run('commit');
  assert.equal(JSON.stringify(app.calls), JSON.stringify([
    ['add', ['/repo/a']], ['commit', 'feat: example', { all: false, postCommitCommand: null }]
  ]));
});
test('已有部分暂存时不重新暂存整个文件', async () => {
  const app = await setup({ staged: true }); await app.run('commit');
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0][0], 'commit');
});
test('取消说明或文件选择不改变暂存区', async () => {
  for (const options of [{ message: undefined, cancelFiles: true }, { message: '' }, { message: null }]) {
    const app = await setup(options); await app.run('commit'); assert.equal(app.calls.length, 0);
  }
});
test('保存失败与 hooks 失败会显示错误', async () => {
  const app = await setup({ save: false }); await app.run('commit');
  assert.equal(app.calls.length, 0); assert.match(app.errors[0], /保存/);
  const hooks = await setup({ commitError: true }); await hooks.run('commit');
  assert.match(hooks.errors[0], /hook rejected/);
});
test('输入说明期间暂存区变化会中止文件提交', async () => {
  let app;
  app = await setup({ message: () => { app.repo.state.indexChanges = [app.repo.state.workingTreeChanges[1]]; return 'message'; } });
  await app.run('commit'); assert.equal(app.calls.length, 0); assert.match(app.errors[0], /暂存区已变化/);
});
test('首次推送选择远程并设置上游', async () => {
  const app = await setup(); delete app.repo.state.HEAD.upstream; await app.run('push');
  assert.equal(JSON.stringify(app.calls), JSON.stringify([['push', 'origin', 'main', true]]));
});
test('同仓库重复操作不会清除正在运行的操作锁', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const app = await setup({ message: () => pending });
  const first = app.run('commit');
  await new Promise(resolve => setImmediate(resolve));
  await app.run('push'); await app.run('push');
  assert.equal(app.calls.length, 0);
  release(null); await first;
  await app.run('push'); assert.equal(app.calls.length, 1);
});
