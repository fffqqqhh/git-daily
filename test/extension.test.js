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
  const globalSaved = new Map();
  const executed = [], inputs = [];
  const contents = new Map();
  let timer, onConfig, provider;
  const config = { enabled: false, reminderTime: '00:00', weekdaysOnly: false, onlyWhenDirty: true, ...options.config };
  config.get = (key, fallback) => config[key] ?? fallback;
  const disposable = { dispose() {} };
  const event = () => disposable;
  const file = name => ({ uri: { fsPath: `/repo/${name}`, toString: () => `file:///repo/${name}` } });
  const repo = {
    rootUri: { fsPath: '/repo', toString: () => 'file:///repo' }, inputBox: { value: '' },
    state: { HEAD: { name: 'main', commit: 'abc', upstream: {} }, indexChanges: options.staged ? [file('a')] : [], workingTreeChanges: options.initialClean ? [] : [file('a'), file('b')], untrackedChanges: [], mergeChanges: [], remotes: [{ name: 'origin' }], onDidChange: event },
    diff: async () => options.diff ? options.diff() : '',
    status: async () => {}, add: async paths => { calls.push(['add', paths]); },
    commit: async (message, opts) => { calls.push(['commit', message, opts]); if (options.commitError) throw new Error('hook rejected'); },
    push: async (...args) => { calls.push(['push', ...args]); if (options.pushError) throw new Error('network unavailable'); },
    pull: async () => calls.push(['pull'])
  };
  if (options.onStatus) repo.status = async () => options.onStatus(repo);
  repo.inputBox.value = options.scmMessage || '';
  const repos = [repo];
  if (options.twoRepos) repos.push({ ...repo, rootUri: { fsPath: '/other', toString: () => 'file:///other' } });
  let input = options.message === undefined ? 'feat: 新增提交面板' : options.message;
  const vscode = {
    Uri: { joinPath: (_base, name) => ({ fsPath: `/extension/${name}` }) },
    EventEmitter: class { event = event; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class {},
    TreeItemCollapsibleState: { Expanded: 2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
    extensions: { getExtension: () => ({ activate: async () => ({ enabled: true, getAPI: () => ({ repositories: repos, onDidOpenRepository: event, onDidCloseRepository: event }) }) }) },
    workspace: { fs: { stat: async () => ({}), readFile: async uri => Buffer.from(contents.get(uri.fsPath) || 'example') }, isTrusted: true, getConfiguration: () => config, onDidChangeConfiguration: fn => { onConfig = fn; return disposable; }, saveAll: async () => options.save !== false },
    window: {
      state: { focused: options.focused !== false }, createOutputChannel: () => ({ ...disposable, appendLine() {}, show() {} }),
      createStatusBarItem: () => ({ ...disposable, show() {}, hide() {} }), registerTreeDataProvider: (_id, value) => { provider = value; return disposable; },
      onDidChangeWindowState: event,
      showQuickPick: async (items, config) => {
        if (config?.title === '选择提交说明模板') {
          if (options.cancelTemplate) return undefined;
          if (options.templatePrefix) return items.find(item => item.prefix === options.templatePrefix);
        }
        return config?.canPickMany ? (options.cancelFiles ? undefined : [items[0]]) : items[0];
      },
      showInputBox: async prompt => { inputs.push(prompt); return typeof input === 'function' ? input() : input; },
      showInformationMessage: async (...args) => { notifications.push(args); return options.notification ? options.notification(...args) : args[0] === '确认本次提交' ? '确认提交' : undefined; },
      showErrorMessage: async message => { errors.push(message); },
      withProgress: async (_options, action) => action()
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable; }, executeCommand: async (...args) => { executed.push(args); } }
  };
  const context = { extension: { packageJSON: { version: '0.3.0' } }, extensionUri: {}, globalState: { get: key => globalSaved.get(key), update: async (key, value) => { globalSaved.set(key, value); } }, subscriptions: [], workspaceState: { get: (key, fallback) => saved.get(key) ?? fallback, update: async (key, value) => { saved.set(key, value); } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : name === './core' ? core : name === './dashboard' ? require('../src/dashboard') : name === './releaseNotes' ? require('../src/releaseNotes') : require(name),
    setInterval: fn => { timer = fn; return 1; }, clearInterval() {}, Date: options.fixedTime ? NoonDate : Date, Set, Map, Intl
  });
  await module.exports.activate(context);
  return { provider, repo, calls, errors, notifications, saved, config, contents, executed, inputs, window: vscode.window,
    tick: async () => { timer(); await new Promise(resolve => setImmediate(resolve)); },
    configure: async values => { Object.assign(config, values); onConfig({ affectsConfiguration: () => true }); await new Promise(resolve => setImmediate(resolve)); },
    run: action => commands.get(`gitDaily.${action}`)(repo) };
}

test('选择文件提交：只暂存所选文件，并禁用提交后的隐式推送', async () => {
  const app = await setup(); await app.run('commit');
  assert.equal(JSON.stringify(app.calls), JSON.stringify([
    ['add', ['/repo/a']], ['commit', 'feat: 新增提交面板', { all: false, postCommitCommand: null }]
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

test('提交确认展示仓库、分支、已选及未选改动', async () => {
  const app = await setup(); await app.run('commit');
  const confirmation = app.notifications.find(args => args[0] === '确认本次提交');
  assert.equal(confirmation[1].modal, true);
  assert.match(confirmation[1].detail, /分支：main/);
  assert.match(confirmation[1].detail, /• a/);
  assert.match(confirmation[1].detail, /1 个文件的未选中改动不会提交/);
  assert.match(confirmation[1].detail, /feat: 新增提交面板/);
});
test('中文说明模板正确预填，已有说明可保留，类型后必须填写摘要', async () => {
  const app = await setup({ templatePrefix: 'docs: ', message: 'docs: 补充使用说明' }); await app.run('commit');
  assert.equal(app.inputs[0].value, 'docs: ');
  assert.equal(app.calls.find(call => call[0] === 'commit')[1], 'docs: 补充使用说明');
  assert(app.inputs[0].validateInput('docs: '));
  assert.equal(app.inputs[0].validateInput('docs: 补充使用说明'), undefined);
  const existing = await setup({ scmMessage: 'fix: 修复旧问题' }); await existing.run('commit');
  assert.equal(existing.inputs[0].value, 'fix: 修复旧问题');
});
test('取消模板、取消确认或返回查看不会暂存和提交', async () => {
  for (const options of [
    { cancelTemplate: true },
    { notification: () => undefined },
    { notification: message => message === '确认本次提交' ? '返回查看改动' : undefined }
  ]) {
    const app = await setup(options); await app.run('commit');
    assert.equal(app.calls.length, 0);
  }
});
test('部分暂存确认明确保留未暂存部分', async () => {
  const app = await setup({ staged: true }); await app.run('commit');
  const confirmation = app.notifications.find(args => args[0] === '确认本次提交');
  assert.match(confirmation[1].detail, /仅提交已暂存内容，保留部分暂存/);
  assert.match(confirmation[1].detail, /2 个文件的未暂存改动不会提交/);
});
test('确认时分支、已暂存内容或所选文件变化均中止提交', async () => {
  for (const kind of ['branch', 'index', 'file']) {
    let app, index = '';
    app = await setup({ diff: () => index, notification: message => {
      if (message !== '确认本次提交') return;
      if (kind === 'branch') app.repo.state.HEAD.name = 'other';
      if (kind === 'index') index = 'different staged content';
      if (kind === 'file') app.contents.set('/repo/a', 'changed while confirming');
      return '确认提交';
    } });
    await app.run('commit');
    assert.equal(app.calls.length, 0);
    assert.match(app.errors[0], /确认期间/);
  }
});
test('提交成功后可立即推送，推送失败保留成功提交且不重复提交', async () => {
  const app = await setup({ pushError: true, notification: message => message === '确认本次提交' ? '确认提交' : message.includes('已提交到本地') ? '立即推送' : undefined });
  await app.run('commit');
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'commit', 'push']);
  assert.match(app.errors[0], /推送失败.*本地提交已保留/);
});
test('立即推送前切换分支会阻止误推送', async () => {
  let app;
  app = await setup({ notification: message => {
    if (message === '确认本次提交') return '确认提交';
    if (message.includes('已提交到本地')) { app.repo.state.HEAD.name = 'other'; return '立即推送'; }
  } });
  await app.run('commit');
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'commit']);
  assert.match(app.errors[0], /分支或提交已变化/);
});
test('本地提交失败不提供立即推送', async () => {
  const app = await setup({ commitError: true }); await app.run('commit');
  assert(!app.notifications.some(args => args[0].includes('已提交到本地')));
  assert(!app.calls.some(call => call[0] === 'push'));
});
test('等待提交后通知时已释放仓库锁，允许手动推送', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const app = await setup({ notification: message => message === '确认本次提交' ? '确认提交' : message.includes('已提交到本地') ? pending : undefined });
  const commit = app.run('commit');
  await new Promise(resolve => setImmediate(resolve));
  await app.run('push');
  assert.equal(app.calls.at(-1)[0], 'push');
  release(undefined); await commit;
});
