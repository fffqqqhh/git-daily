'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextReminder, dayKey } = require('../src/core');
const { createDashboard } = require('../src/dashboard');
const cfg = { enabled: true, reminderTime: '17:30', weekdaysOnly: false, onlyWhenDirty: true };
const date = (day, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute);
const change = name => ({ uri: { toString: () => `file:///repo/${name}`, fsPath: `/repo/${name}` } });
const state = () => ({ HEAD: { name: 'main', commit: 'abc', upstream: { commit: 'def' }, ahead: 2, behind: 1 }, indexChanges: [], workingTreeChanges: [change('a.txt')], mergeChanges: [], untrackedChanges: [] });

test('下次提醒：今日、已提醒后的明日、工作日跨周', () => {
  const s = state();
  assert.equal(nextReminder(date(13), cfg, {}, s).date.getTime(), date(13, 17, 30).getTime());
  const saved = { day: dayKey(date(13)), time: '17:30' };
  assert.equal(nextReminder(date(13, 18), cfg, saved, s).date.getTime(), date(14, 17, 30).getTime());
  assert.equal(nextReminder(date(13, 18), { ...cfg, weekdaysOnly: true }, saved, s).date.getTime(), date(16, 17, 30).getTime());
});
test('下次提醒：稍后、跨日延后与到期', () => {
  const s = state();
  const saved = { day: dayKey(date(11)), time: '17:30', snoozeUntil: date(11, 18, 30).getTime() };
  assert.equal(nextReminder(date(11, 18), cfg, saved, s).date.getTime(), saved.snoozeUntil);
  assert.equal(nextReminder(date(11, 19), cfg, saved, s).label, '即将提醒');
  saved.snoozeUntil = date(12, 1).getTime();
  assert.equal(nextReminder(date(11, 23), cfg, saved, s).date.getTime(), date(12, 17, 30).getTime());
});
test('下次提醒：关闭、无效时间、清洁仓库与修改当天时间', () => {
  const s = state();
  assert.equal(nextReminder(date(11), { ...cfg, enabled: false }, {}, s).date, undefined);
  assert.equal(nextReminder(date(11), { ...cfg, reminderTime: '99:00' }, {}, s).date, undefined);
  s.workingTreeChanges = []; s.HEAD.ahead = 0;
  assert.equal(nextReminder(date(11, 18), cfg, {}, s).label, '有改动后提醒（已到时间）');
  const saved = { day: dayKey(date(11)), time: '17:29' };
  s.HEAD.ahead = 1;
  assert.equal(nextReminder(date(11, 18), cfg, saved, s).label, '即将提醒');
});

function dashboard(options = {}) {
  const repo = { rootUri: { fsPath: '/repo', toString: () => 'file:///repo' }, state: state(), log: options.log || (async () => [{ hash: 'abcdef0123', message: 'fix: example\n\ndetails' }]) };
  const provider = createDashboard({
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }
  }, { api: { repositories: [repo] }, context: { workspaceState: { get: () => options.saved || {} } },
    config: () => ({ ...cfg, ...options.config }), pending: () => options.pending || false, now: () => date(11) });
  return { repo, provider, rows: async () => provider.getChildren((await provider.getChildren())[0]) };
}

test('面板呈现分支、文件、待推送、下次提醒及正确仓库的提交推送入口', async () => {
  const app = dashboard(); const rows = await app.rows();
  assert(rows.some(row => row.label === '当前分支：main'));
  assert(rows.some(row => row.label === '未提交文件（1）'));
  assert(rows.some(row => row.label === '待推送提交：2 条'));
  assert.equal(rows.find(row => row.kind === 'nextReminder').description, '今天 17:30');
  for (const action of ['commit', 'push']) {
    const row = rows.find(row => row.kind === `action:${action}`);
    assert.equal(row.command.command, `gitDaily.${action}`);
    assert.equal(row.command.arguments[0], app.repo);
  }
  assert(!rows.some(row => row.command?.command === 'gitDaily.testReminder'));
});
test('部分暂存文件去重并显示两种状态，打开真实文件差异', async () => {
  const app = dashboard(); app.repo.state.indexChanges = [change('a.txt')];
  const rows = await app.rows(); const files = await app.provider.getChildren(rows.find(row => row.kind === 'files'));
  assert.equal(files.length, 1); assert.equal(files[0].description, '已暂存 · 未暂存');
  assert.equal(files[0].command.command, 'git.openChange');
  assert.equal(files[0].command.arguments[0].fsPath, '/repo/a.txt');
});
test('Git 将未跟踪文件放在工作区列表时仍能标识为未跟踪', async () => {
  const app = dashboard(); app.repo.state.workingTreeChanges[0].status = 7;
  const rows = await app.rows(); const files = await app.provider.getChildren(rows.find(row => row.kind === 'files'));
  assert.equal(files[0].description, '未跟踪');
});
test('待推送列表以本地和上游提交差集查询，失败时提供获取入口', async () => {
  let query;
  const app = dashboard({ log: async value => { query = value; return [{ hash: '123456789', message: 'feat: dashboard' }]; } });
  let rows = await app.rows(); let commits = await app.provider.getChildren(rows.find(row => row.kind === 'outgoing'));
  assert.deepEqual(query, { range: 'def..abc', maxEntries: 50 });
  assert.equal(commits[0].label, 'feat: dashboard');
  app.repo.log = async () => { throw new Error('missing ref'); };
  commits = await app.provider.getChildren(rows.find(row => row.kind === 'outgoing'));
  assert.equal(commits[0].command.command, 'gitDaily.fetch');
});
test('无上游、未知状态与分离 HEAD 不被显示为零待推送', async () => {
  const app = dashboard(); delete app.repo.state.HEAD.upstream;
  let rows = await app.rows(); assert.equal(rows.find(row => row.kind === 'outgoing').label, '待推送提交：未关联远程分支');
  app.repo.state.HEAD.upstream = {}; delete app.repo.state.HEAD.ahead;
  rows = await app.rows(); assert.equal(rows.find(row => row.kind === 'outgoing').label, '待推送提交：状态未知');
  delete app.repo.state.HEAD.name;
  rows = await app.rows(); assert.match(rows[0].label, /分离 HEAD/);
});
test('今日提醒、关闭和等待处理状态各自显示', async () => {
  const app = dashboard({ saved: { day: dayKey(date(11)), time: '17:30' } });
  let rows = await app.rows(); assert.equal(rows.find(row => row.kind === 'today').description, '已发送');
  rows = await dashboard({ config: { enabled: false } }).rows();
  assert.equal(rows.find(row => row.kind === 'nextReminder').description, '提醒已关闭');
  rows = await dashboard({ pending: true }).rows();
  assert.equal(rows.find(row => row.kind === 'nextReminder').description, '已有提醒等待处理');
});
