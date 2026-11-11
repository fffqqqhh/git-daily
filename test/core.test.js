'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dayKey, reminderDue, reminderReason, changes, syncRepository } = require('../src/core');
const config = { enabled: true, reminderTime: '17:30', weekdaysOnly: false, onlyWhenDirty: true };
const change = name => ({ uri: { toString: () => name } });
const state = () => ({ HEAD: { name: 'main', commit: 'abc', upstream: { remote: 'origin', name: 'main' } }, indexChanges: [], workingTreeChanges: [], untrackedChanges: [], mergeChanges: [] });
const now = new Date(2026, 10, 11, 17, 30);

test('到点提醒，提前不提醒，重启同日不重复提醒', () => {
  const s = state(); s.workingTreeChanges.push(change('a'));
  assert.equal(reminderDue(new Date(2026, 10, 11, 17, 29), config, {}, s), false);
  assert.equal(reminderDue(now, config, {}, s), true);
  assert.equal(reminderDue(now, config, { day: dayKey(now), time: '17:30' }, s), false);
  assert.equal(reminderDue(now, config, { day: '2026-11-10' }, s), true);
});
test('稍后提醒在到期后恢复', () => {
  const s = state(); s.workingTreeChanges.push(change('a'));
  const saved = { day: dayKey(now), time: '17:30', snoozeUntil: now.getTime() + 60000 };
  assert.equal(reminderDue(now, config, saved, s), false);
  assert.equal(reminderDue(new Date(now.getTime() + 60000), config, saved, s), true);
});
test('清洁仓库不提醒，待推送提交会提醒', () => {
  const s = state();
  assert.equal(reminderDue(now, config, {}, s), false);
  s.HEAD.ahead = 1;
  assert.equal(reminderDue(now, config, {}, s), true);
  assert.equal(reminderDue(now, { ...config, enabled: false }, {}, s), false);
});
test('周末、无效时间与跨日稍后提醒', () => {
  const s = state(); s.untrackedChanges.push(change('b'));
  assert.equal(reminderDue(new Date(2026, 10, 14, 18), { ...config, weekdaysOnly: true }, {}, s), false);
  assert.equal(reminderDue(now, { ...config, reminderTime: '25:00' }, {}, s), false);
  assert.equal(reminderDue(now, config, { day: '2026-11-10', snoozeUntil: now.getTime() + 1000 }, s), true);
});
test('同一文件部分暂存时只计数一次', () => {
  const s = state(); s.indexChanges.push(change('a')); s.workingTreeChanges.push(change('a'));
  assert.equal(changes(s).length, 1);
});
test('同日调整提醒时间可再提醒，旧版本记录不会阻止升级后测试', () => {
  const s = state(); s.workingTreeChanges.push(change('a'));
  assert.equal(reminderDue(now, config, { day: dayKey(now), time: '17:29' }, s), true);
  assert.equal(reminderDue(now, config, { day: dayKey(now) }, s), true);
  assert.equal(reminderReason(now, config, { day: dayKey(now), time: '17:30' }, s), '今天此时间已提醒');
});
test('同步先拉取后推送', async () => {
  const calls = [];
  const repo = { state: state(), status: async () => calls.push('status'), pull: async () => calls.push('pull'), push: async () => calls.push('push') };
  await syncRepository(repo);
  assert.deepEqual(calls, ['status', 'pull', 'status', 'push']);
});
test('拉取失败不会推送', async () => {
  let pushed = false;
  const repo = { state: state(), status: async () => {}, pull: async () => { throw new Error('conflict'); }, push: async () => { pushed = true; } };
  await assert.rejects(syncRepository(repo), /conflict/);
  assert.equal(pushed, false);
});
test('有改动、冲突、变基、无上游、分离 HEAD、首次提交前均阻止同步', async () => {
  for (const mutate of [
    s => s.workingTreeChanges.push(change('a')), s => s.mergeChanges.push(change('a')),
    s => { s.rebaseCommit = {}; }, s => { delete s.HEAD.upstream; },
    s => { delete s.HEAD.name; }, s => { delete s.HEAD.commit; }
  ]) {
    const s = state(); mutate(s);
    let pulled = false;
    const repo = { state: s, status: async () => {}, pull: async () => { pulled = true; }, push: async () => {} };
    await assert.rejects(syncRepository(repo));
    assert.equal(pulled, false);
  }
});
