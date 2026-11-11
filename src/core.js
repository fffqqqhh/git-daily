'use strict';

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function changes(state) {
  return [...new Map([
    ...(state.indexChanges || []), ...(state.workingTreeChanges || []),
    ...(state.untrackedChanges || []), ...(state.mergeChanges || [])
  ].map(change => [change.uri.toString(), change])).values()];
}

function reminderReason(now, config, saved, state) {
  if (!config.enabled) return '提醒已关闭';
  if (config.weekdaysOnly && [0, 6].includes(now.getDay())) return '今天不是工作日';
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(config.reminderTime);
  if (!match) return '提醒时间格式无效';
  if (now.getHours() * 60 + now.getMinutes() < Number(match[1]) * 60 + Number(match[2])) return '尚未到提醒时间';
  if (saved.day === dayKey(now) && saved.time === config.reminderTime) {
    if (!saved.snoozeUntil) return '今天此时间已提醒';
    if (now.getTime() < saved.snoozeUntil) return '尚未到稍后提醒时间';
  }
  if (config.onlyWhenDirty && !changes(state).length && !(state.HEAD?.ahead > 0)) return '没有已保存的改动或待推送提交';
  return undefined;
}

function reminderDue(now, config, saved, state) {
  return reminderReason(now, config, saved, state) === undefined;
}

function assertResolved(repo) {
  if (repo.state.mergeChanges.length) throw new Error('仓库存在冲突，请先在源代码管理中解决冲突。');
  if (repo.state.rebaseCommit) throw new Error('仓库正在变基，请先完成或中止变基。');
}

function assertBranch(repo) {
  if (!repo.state.HEAD?.name) throw new Error('当前处于分离 HEAD 状态，请先切换到分支。');
  if (!repo.state.HEAD.commit) throw new Error('请先创建首次提交，再推送。');
}

async function syncRepository(repo) {
  await repo.status();
  assertResolved(repo);
  assertBranch(repo);
  if (!repo.state.HEAD.upstream) throw new Error('当前分支尚未关联远程分支，请先使用“推送”设置上游。');
  if (changes(repo.state).length) throw new Error('同步前请先提交改动，或在源代码管理中手动暂存为 stash。');
  // A failed pull must never be followed by a push.
  await repo.pull();
  await repo.status();
  assertResolved(repo);
  await repo.push();
}

module.exports = { dayKey, changes, reminderDue, reminderReason, assertResolved, assertBranch, syncRepository };
