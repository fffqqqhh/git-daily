'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { dayKey, changes, reminderDue, assertResolved, assertBranch, syncRepository } = require('./core');

async function activate(context) {
  const output = vscode.window.createOutputChannel('Git Daily');
  context.subscriptions.push(output);
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) return;
  const git = await extension.activate();
  if (!git.enabled) {
    vscode.window.showWarningMessage('Git Daily：请在设置中启用 Git，然后重新加载窗口。');
    return;
  }
  const api = git.getAPI(1);
  const emitter = new vscode.EventEmitter();
  const busy = new Set();
  const subscriptions = new Map();
  let checking = false;
  let disposed = false;
  const title = repo => path.basename(repo.rootUri.fsPath);
  const key = repo => repo.rootUri.toString();
  const config = () => vscode.workspace.getConfiguration('gitDaily');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'gitDaily.repositories.focus';
  context.subscriptions.push(emitter, status);

  function refresh() {
    emitter.fire();
    const dirty = api.repositories.filter(repo => changes(repo.state).length).length;
    status.text = `$(git-commit) Git Daily${dirty ? ` · ${dirty} 待提交` : ''}`;
    status.tooltip = '打开每日提交助手';
    if (api.repositories.length) status.show(); else status.hide();
  }

  const provider = {
    onDidChangeTreeData: emitter.event,
    getTreeItem: item => item,
    getChildren(item) {
      if (!item) return api.repositories.map(repo => {
        const node = new vscode.TreeItem(title(repo), vscode.TreeItemCollapsibleState.Expanded);
        node.repo = repo;
        node.description = repo.state.HEAD?.name || '未创建分支';
        node.tooltip = repo.rootUri.fsPath;
        node.iconPath = new vscode.ThemeIcon('repo');
        return node;
      });
      const repo = item.repo;
      const head = repo.state.HEAD;
      const summary = new vscode.TreeItem(`${changes(repo.state).length} 个改动 · ↑${head?.ahead || 0} ↓${head?.behind || 0}`);
      summary.tooltip = '远程计数基于上次获取的状态，点击“获取远程状态”更新。';
      return [summary, ...[
        ['review', '查看改动', 'diff'], ['commit', '提交代码', 'git-commit'],
        ['push', '推送', 'cloud-upload'], ['sync', '同步（先拉取，再推送）', 'sync'],
        ['fetch', '获取远程状态', 'cloud-download']
      ].map(([action, label, icon]) => {
        const node = new vscode.TreeItem(label);
        node.iconPath = new vscode.ThemeIcon(icon);
        node.command = { command: `gitDaily.${action}`, title: label, arguments: [repo] };
        return node;
      })];
    }
  };
  context.subscriptions.push(vscode.window.registerTreeDataProvider('gitDaily.repositories', provider));

  async function selectRepository(candidate) {
    if (candidate && api.repositories.includes(candidate)) return candidate;
    if (!api.repositories.length) throw new Error('没有发现 Git 仓库，请先打开仓库文件夹。');
    if (api.repositories.length === 1) return api.repositories[0];
    const selected = await vscode.window.showQuickPick(api.repositories.map(repo => ({
      label: title(repo), description: repo.rootUri.fsPath, repo
    })), { placeHolder: '选择要操作的仓库' });
    return selected?.repo;
  }

  async function report(error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
    const action = await vscode.window.showErrorMessage(`Git Daily：${message}`, '查看日志', '查看改动');
    if (action === '查看日志') output.show();
    if (action === '查看改动') await vscode.commands.executeCommand('workbench.view.scm');
  }

  async function operate(candidate, label, task) {
    let repo;
    let acquired = false;
    try {
      repo = await selectRepository(candidate);
      if (!repo) return;
      if (busy.has(key(repo))) {
        vscode.window.showInformationMessage('该仓库正在执行操作，请稍候。');
        return;
      }
      busy.add(key(repo));
      acquired = true;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Git Daily · ${title(repo)} · ${label}` }, async () => {
        await repo.status();
        await task(repo);
      });
    } catch (error) { await report(error); }
    finally {
      if (acquired) busy.delete(key(repo));
      refresh();
    }
  }

  async function commit(repo) {
    assertResolved(repo);
    if (!changes(repo.state).length) {
      vscode.window.showInformationMessage('没有需要提交的改动。');
      return;
    }
    let selected;
    const staged = repo.state.indexChanges.length;
    if (staged) {
      const choice = await vscode.window.showQuickPick([
        { label: `提交已暂存的 ${staged} 个文件`, action: 'staged' },
        { label: '查看改动后再提交', action: 'review' }
      ], { placeHolder: '保留部分暂存的内容，仅提交暂存区' });
      if (!choice) return;
      if (choice.action === 'review') return vscode.commands.executeCommand('workbench.view.scm');
    } else {
      selected = await vscode.window.showQuickPick(changes(repo.state).map(change => ({
        label: path.relative(repo.rootUri.fsPath, change.uri.fsPath), change
      })), { canPickMany: true, placeHolder: '选择本次提交的文件（所选文件将按完整文件暂存）' });
      if (!selected?.length) return;
    }
    const message = await vscode.window.showInputBox({
      title: `提交到 ${title(repo)} · ${repo.state.HEAD?.name || '新分支'}`,
      prompt: '填写提交说明；取消不会暂存新文件。提交成功后可单独推送。',
      value: repo.inputBox.value,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : '请填写提交说明'
    });
    if (!message?.trim()) return;
    if (!await vscode.workspace.saveAll(false)) throw new Error('部分文件未能保存，请保存后重试。');
    await repo.status();
    assertResolved(repo);
    // Do not accidentally include staging performed by another UI during the prompt.
    if (selected && repo.state.indexChanges.length) throw new Error('暂存区已变化，请重新提交并检查暂存文件。');
    if (!selected && !repo.state.indexChanges.length) throw new Error('暂存区已清空，请重新选择文件。');
    if (selected) await repo.add(selected.map(item => item.change.uri.fsPath));
    await repo.commit(message.trim(), { all: false, postCommitCommand: null });
    repo.inputBox.value = '';
    await repo.status();
    vscode.window.showInformationMessage('提交成功。需要上传时点击“推送”。');
  }

  async function push(repo) {
    assertResolved(repo);
    assertBranch(repo);
    if (!repo.state.HEAD.upstream) {
      const remotes = repo.state.remotes.filter(remote => !remote.isReadOnly);
      if (!remotes.length) throw new Error('未配置可推送的远程仓库，请先在源代码管理中添加远程。');
      const remote = await vscode.window.showQuickPick(remotes.map(item => item.name), { placeHolder: '选择远程，将当前分支推送并设置上游' });
      if (!remote) return;
      await repo.push(remote, repo.state.HEAD.name, true);
    } else { await repo.push(); }
    await repo.status();
    vscode.window.showInformationMessage('推送成功。');
  }

  async function checkReminders() {
    if (checking || disposed || !vscode.window.state.focused || !vscode.workspace.isTrusted) return;
    checking = true;
    try {
      for (const repo of api.repositories) {
        if (disposed) break;
        if (busy.has(key(repo))) continue;
        const savedKey = `reminder:${key(repo)}`;
        const now = new Date();
        const saved = context.workspaceState.get(savedKey, {});
        if (!reminderDue(now, config(), saved, repo.state)) continue;
        await repo.status();
        if (!reminderDue(now, config(), saved, repo.state)) continue;
        const day = dayKey(now);
        await context.workspaceState.update(savedKey, { day });
        const count = changes(repo.state).length;
        const action = await vscode.window.showInformationMessage(
          `Git Daily · ${title(repo)}：${count ? `还有 ${count} 个文件未提交` : repo.state.HEAD?.ahead ? '有本地提交待推送' : '到每日检查时间了'}。`,
          '查看改动', '提交代码', '推送', '稍后提醒', '今天忽略'
        );
        if (disposed) break;
        if (action === '稍后提醒') {
          await context.workspaceState.update(savedKey, { day, snoozeUntil: Date.now() + config().get('snoozeMinutes', 30) * 60000 });
        } else if (action === '查看改动') await vscode.commands.executeCommand('workbench.view.scm');
        else if (action === '提交代码') await operate(repo, '提交代码', commit);
        else if (action === '推送') await operate(repo, '推送', push);
      }
    } catch (error) { output.appendLine(`提醒检查失败：${error.message}`); }
    finally { checking = false; }
  }

  function watch(repo) {
    if (subscriptions.has(repo)) return;
    subscriptions.set(repo, repo.state.onDidChange(refresh));
    refresh();
    void checkReminders();
  }
  context.subscriptions.push(
    api.onDidOpenRepository(watch),
    api.onDidCloseRepository(repo => { subscriptions.get(repo)?.dispose(); subscriptions.delete(repo); refresh(); }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitDaily')) void checkReminders(); }),
    vscode.window.onDidChangeWindowState(state => { if (state.focused) void checkReminders(); }),
    vscode.commands.registerCommand('gitDaily.commit', repo => operate(repo, '提交代码', commit)),
    vscode.commands.registerCommand('gitDaily.push', repo => operate(repo, '推送', push)),
    vscode.commands.registerCommand('gitDaily.sync', repo => operate(repo, '同步', async selected => {
      await syncRepository(selected);
      vscode.window.showInformationMessage('同步完成。');
    })),
    vscode.commands.registerCommand('gitDaily.fetch', repo => operate(repo, '获取远程状态', selected => selected.fetch({ all: true }))),
    vscode.commands.registerCommand('gitDaily.refresh', () => Promise.all(api.repositories.map(repo => operate(repo, '刷新', selected => selected.status())))),
    vscode.commands.registerCommand('gitDaily.review', () => vscode.commands.executeCommand('workbench.view.scm')),
    vscode.commands.registerCommand('gitDaily.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'gitDaily'))
  );
  api.repositories.forEach(watch);
  const timer = setInterval(() => void checkReminders(), 30000);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); subscriptions.forEach(item => item.dispose()); } });
  refresh();
}

module.exports = { activate };
