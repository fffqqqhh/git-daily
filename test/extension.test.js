'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/core');
class NoonDate extends Date {
  constructor(...args) { super(...(args.length ? args : [2026, 10, 11, 12])); }
}

async function setup(options = {}) {
  const commands = new Map(), calls = [], errors = [], notifications = [];
  const saved = new Map(options.saved || []);
  let timer, onConfig;
  const config = { enabled: false, reminderTime: '00:00', weekdaysOnly: false, onlyWhenDirty: true, ...options.config };
  config.get = (key, fallback) => config[key] ?? fallback;
  const disposable = { dispose() {} };
  const event = () => disposable;
  const file = name => ({ uri: { fsPath: `/repo/${name}`, toString: () => `file:///repo/${name}` } });
  const repo = {
    rootUri: { fsPath: '/repo', toString: () => 'file:///repo' }, inputBox: { value: '' },
    state: { HEAD: { name: 'main', commit: 'abc', upstream: {} }, indexChanges: options.staged ? [file('a')] : [], workingTreeChanges: options.initialClean ? [] : [file('a'), file('b')], untrackedChanges: [], mergeChanges: [], remotes: [{ name: 'origin' }], onDidChange: event },
    status: async () => {}, add: async paths => { calls.push(['add', paths]); },
    commit: async (message, opts) => { calls.push(['commit', message, opts]); if (options.commitError) throw new Error('hook rejected'); },
    push: async (...args) => calls.push(['push', ...args]),
    pull: async () => calls.push(['pull'])
  };
  if (options.onStatus) repo.status = async () => options.onStatus(repo);
  const repos = [repo];
  if (options.twoRepos) repos.push({ ...repo, rootUri: { fsPath: '/other', toString: () => 'file:///other' } });
  let input = options.message === undefined ? 'feat: example' : options.message;
  const vscode = {
    EventEmitter: class { event = event; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class {},
    TreeItemCollapsibleState: { Expanded: 2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
    extensions: { getExtension: () => ({ activate: async () => ({ enabled: true, getAPI: () => ({ repositories: repos, onDidOpenRepository: event, onDidCloseRepository: event }) }) }) },
    workspace: { isTrusted: true, getConfiguration: () => config, onDidChangeConfiguration: fn => { onConfig = fn; return disposable; }, saveAll: async () => options.save !== false },
    window: {
      state: { focused: options.focused !== false }, createOutputChannel: () => ({ ...disposable, appendLine() {}, show() {} }),
      createStatusBarItem: () => ({ ...disposable, show() {}, hide() {} }), registerTreeDataProvider: () => disposable,
      onDidChangeWindowState: event,
      showQuickPick: async (items, config) => config?.canPickMany ? (options.cancelFiles ? undefined : [items[0]]) : items[0],
      showInputBox: async () => typeof input === 'function' ? input() : input,
      showInformationMessage: async (...args) => { notifications.push(args); return options.notification ? options.notification(...args) : undefined; },
      showErrorMessage: async message => { errors.push(message); },
      withProgress: async (_options, action) => action()
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable; }, executeCommand: async () => {} }
  };
  const context = { subscriptions: [], workspaceState: { get: (key, fallback) => saved.get(key) ?? fallback, update: async (key, value) => { saved.set(key, value); } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : name === './core' ? core : require(name),
    setInterval: fn => { timer = fn; return 1; }, clearInterval() {}, Date: options.fixedTime ? NoonDate : Date, Set, Map, Intl
  });
  await module.exports.activate(context);
  return { repo, calls, errors, notifications, saved, config, window: vscode.window,
    tick: async () => { timer(); await new Promise(resolve => setImmediate(resolve)); },
    configure: async values => { Object.assign(config, values); onConfig({ affectsConfiguration: () => true }); await new Promise(resolve => setImmediate(resolve)); },
    run: action => commands.get(`gitDaily.${action}`)(repo) };
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

test('测试提醒在关闭提醒、无改动、非前台时仍显示对话框且不消耗记录', async () => {
  const app = await setup({ focused: false });
  app.repo.state.workingTreeChanges = [];
  await app.run('testReminder');
  assert.match(app.notifications[0][0], /测试提醒/);
  assert.equal(app.notifications[0][1].modal, true);
  assert.equal(app.saved.size, 0);
});
test('自动提醒真实调度路径：刷新后判断、同日去重、修改时间后再次触发', async () => {
  const app = await setup({ fixedTime: true, config: { enabled: true } });
  await app.tick();
  assert.equal(app.notifications.length, 1);
  await app.tick(); assert.equal(app.notifications.length, 1);
  await app.configure({ reminderTime: '00:01' });
  assert.equal(app.notifications.length, 2);
});
test('未处理通知不阻塞其他仓库或改变时间后的检查', async () => {
  const app = await setup({ fixedTime: true, twoRepos: true, config: { enabled: true }, notification: () => new Promise(() => {}) });
  await app.tick(); assert.equal(app.notifications.length, 2);
  await app.tick(); assert.equal(app.notifications.length, 2);
  await app.configure({ reminderTime: '00:01' });
  assert.equal(app.notifications.length, 4);
});
test('稍后提醒记录保留时间与到期点', async () => {
  const app = await setup({ config: { enabled: true, snoozeMinutes: 5 }, notification: () => '稍后提醒' });
  await app.tick();
  const record = app.saved.get('reminder:file:///repo');
  assert.equal(record.time, '00:00'); assert(record.snoozeUntil > Date.now());
  await app.tick(); assert.equal(app.notifications.length, 1);
});
test('同日记录在重新加载后仍去重', async () => {
  const app = await setup({ config: { enabled: true } }); await app.tick();
  const reloaded = await setup({ config: { enabled: true }, saved: app.saved }); await reloaded.tick();
  assert.equal(reloaded.notifications.length, 0);
});
test('可选对话框模式与诊断报告', async () => {
  const app = await setup({ config: { enabled: true, reminderStyle: 'dialog' } }); await app.tick();
  assert.equal(app.notifications[0][1].modal, true);
  const details = await app.run('reminderStatus');
  assert.match(details, /今天此时间已提醒/); assert.match(details, /扩展宿主时间/);
});
test('仓库初始缓存为空也会在刷新后提醒', async () => {
  let first = true;
  const app = await setup({ initialClean: true, config: { enabled: true }, onStatus: repo => {
    if (first) { repo.state.workingTreeChanges = [{ uri: { toString: () => 'new' } }]; first = false; }
  } });
  await app.tick(); assert.equal(app.notifications.length, 1);
});
test('通知 API 抛错后不永久消耗当日提醒记录', async () => {
  let fail = true;
  const app = await setup({ config: { enabled: true }, notification: () => {
    if (fail) { fail = false; throw new Error('notification failed'); }
  } });
  await app.tick();
  await app.tick();
  assert.equal(app.notifications.length, 2);
});
