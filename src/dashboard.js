'use strict';

const path = require('node:path');
const { changes, nextReminder, dayKey } = require('./core');

function createDashboard(vscode, { api, context, config, onDidChangeTreeData, pending, now = () => new Date() }) {
  const states = vscode.TreeItemCollapsibleState;
  function row(repo, id, label, icon, action, collapsible) {
    const item = new vscode.TreeItem(label, collapsible ?? states.None);
    item.id = `${repo.rootUri.toString()}:${id}`;
    item.repo = repo;
    item.kind = id;
    item.iconPath = new vscode.ThemeIcon(icon);
    if (action) item.command = { command: `gitDaily.${action}`, title: label, arguments: [repo] };
    return item;
  }
  function fileRows(repo) {
    const groups = Object.fromEntries(['mergeChanges', 'indexChanges', 'workingTreeChanges', 'untrackedChanges']
      .map(group => [group, new Set((repo.state[group] || []).map(change => change.uri.toString()))]));
    return changes(repo.state).map(change => {
      const uri = change.uri.toString();
      const labels = [
        ['mergeChanges', '冲突'], ['indexChanges', '已暂存'],
        ['workingTreeChanges', change.status === 7 ? '未跟踪' : '未暂存'], ['untrackedChanges', '未跟踪']
      ].filter(([group]) => groups[group].has(uri)).map(([, label]) => label);
      const item = row(repo, `file:${uri}`, path.relative(repo.rootUri.fsPath, change.uri.fsPath), 'diff');
      item.description = [...new Set(labels)].join(' · ');
      item.tooltip = `${change.uri.fsPath}\n${item.description}\n点击在源代码管理差异编辑器中查看。`;
      item.command = { command: 'git.openChange', title: '查看文件改动', arguments: [change.uri] };
      return item;
    });
  }
  async function commitRows(repo) {
    const head = repo.state.HEAD;
    if (!head?.upstream?.commit || !head.commit) return [row(repo, 'fetchHint', '请先获取远程状态以查看提交', 'info', 'fetch')];
    try {
      const commits = await repo.log({ range: `${head.upstream.commit}..${head.commit}`, maxEntries: 50 });
      const items = commits.map(commit => {
        const item = row(repo, `commit:${commit.hash}`, commit.message.split(/\r?\n/)[0], 'git-commit');
        item.description = commit.hash.slice(0, 7);
        item.tooltip = `${commit.hash}\n${commit.authorName || ''}\n${commit.message}`;
        return item;
      });
      if (commits.length === 50 && head.ahead > 50) items.push(row(repo, 'moreCommits', '仅显示最近 50 条提交', 'info'));
      return items.length ? items : [row(repo, 'emptyCommits', '没有待推送提交', 'check')];
    } catch (error) {
      const item = row(repo, 'logError', '无法读取待推送提交，点击获取远程状态', 'warning', 'fetch');
      item.tooltip = error.message;
      return [item];
    }
  }
  return {
    onDidChangeTreeData,
    getTreeItem: item => item,
    async getChildren(item) {
      if (!item) return api.repositories.map(repo => {
        const root = row(repo, 'repository', path.basename(repo.rootUri.fsPath), 'repo', undefined, states.Expanded);
        root.description = `${changes(repo.state).length} 个文件待提交`;
        root.tooltip = repo.rootUri.fsPath;
        return root;
      });
      const repo = item.repo;
      if (item.kind === 'files') return fileRows(repo);
      if (item.kind === 'outgoing') return commitRows(repo);
      if (item.kind !== 'repository') return [];
      const head = repo.state.HEAD;
      const current = now();
      const saved = context.workspaceState.get(`reminder:${repo.rootUri.toString()}`, {});
      const plan = nextReminder(current, config(), saved, repo.state);
      const branch = head?.name || (head?.commit ? `分离 HEAD · ${head.commit.slice(0, 7)}` : '尚无首次提交');
      const branchRow = row(repo, 'branch', `当前分支：${branch}`, 'git-branch');
      const reminder = row(repo, 'nextReminder', '下次提醒', 'bell', 'settings');
      const dateLabel = plan.date && plan.date > current
        ? `${dayKey(plan.date) === dayKey(current) ? '今天' : dayKey(plan.date)} ${plan.date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
        : plan.label;
      reminder.description = pending(repo) ? '已有提醒等待处理' : dateLabel;
      reminder.tooltip = `${plan.date ? plan.date.toLocaleString('zh-CN') : plan.label}\n扩展宿主时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}\n${config().onlyWhenDirty ? '有已保存改动或待推送提交时提醒。' : ''}需保持 VS Code 运行并处于前台；点击修改设置。`;
      const today = row(repo, 'today', '今日提醒', 'calendar');
      today.description = saved.day === dayKey(current) && saved.time === config().reminderTime
        ? saved.snoozeUntil ? '已延后' : '已发送' : '尚未发送';
      today.tooltip = '“已发送”代表已调用通知接口，不代表已经提交代码。';
      const files = row(repo, 'files', `未提交文件（${changes(repo.state).length}）`, 'files', undefined,
        changes(repo.state).length ? states.Collapsed : states.None);
      files.tooltip = '仅统计 Git 已检测到的已保存文件；部分暂存的文件计数一次。展开可查看文件并打开差异。';
      const outgoingCount = !head?.commit ? '尚无提交' : !head.upstream ? '未关联远程分支' : head.ahead === undefined ? '状态未知' : `${head.ahead} 条`;
      const outgoing = row(repo, 'outgoing', `待推送提交：${outgoingCount}`, 'cloud-upload', undefined,
        head?.ahead > 0 ? states.Collapsed : states.None);
      outgoing.tooltip = '基于最近获取的远程分支状态。点击“获取远程状态”更新；展开最多显示 50 条提交。';
      const incoming = row(repo, 'incoming', `待拉取提交：${!head?.upstream ? '未关联远程分支' : head.behind === undefined ? '状态未知' : `${head.behind} 条`}`, 'cloud-download');
      const operations = [
        ['commit', '提交代码', 'git-commit'], ['push', '推送', 'cloud-upload'],
        ['sync', '同步（先拉取，再推送）', 'sync'], ['fetch', '获取远程状态', 'cloud-download']
      ].map(([action, label, icon]) => row(repo, `action:${action}`, label, icon, action));
      return [branchRow, files, outgoing, incoming, reminder, today, ...operations];
    }
  };
}

module.exports = { createDashboard };
