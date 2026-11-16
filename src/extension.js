'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { createDashboard } = require('./dashboard');
const { registerReleaseNotes } = require('./releaseNotes');
const { dayKey, changes, reminderDue, reminderReason, assertResolved, assertBranch, syncRepository } = require('./core');

function createExtension(vscode) {
  async function activate(context) {
    const output = vscode.window.createOutputChannel('Git Daily');
    context.subscriptions.push(output);
    registerReleaseNotes(vscode, context, output);
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
    const pendingReminders = new Set();
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
      status.tooltip = '打开今日提交状态面板';
      if (api.repositories.length) status.show(); else status.hide();
    }

    const provider = createDashboard(vscode, {
      api, context, config, onDidChangeTreeData: emitter.event,
      pending: repo => pendingReminders.has(`${key(repo)}:${config().reminderTime}`)
    });
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
        return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Git Daily · ${title(repo)} · ${label}` }, async () => {
          await repo.status();
          return await task(repo);
        });
      } catch (error) {
        await report(label === '推送' ? new Error(`推送失败：${error.message}。本地提交已保留，可稍后重新推送。`) : error);
      }
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
      const headKey = () => JSON.stringify([repo.state.HEAD?.name, repo.state.HEAD?.commit]);
      const originalHead = headKey();
      const originalIndex = await repo.diff(true);
      const staged = repo.state.indexChanges.length;
      if (staged) {
        const choice = await vscode.window.showQuickPick([
          { label: `提交已暂存的 ${staged} 个文件`, action: 'staged' },
          { label: '查看改动后再提交', action: 'review' }
        ], { placeHolder: '保留部分暂存的内容，仅提交暂存区' });
        if (!choice) return;
        if (choice.action === 'review') { await vscode.commands.executeCommand('workbench.view.scm'); return; }
      } else {
        selected = await vscode.window.showQuickPick(changes(repo.state).map(change => ({
          label: path.relative(repo.rootUri.fsPath, change.uri.fsPath), change
        })), { canPickMany: true, placeHolder: '选择本次提交的文件（所选文件将按完整文件暂存）' });
        if (!selected?.length) return;
      }
      const template = await vscode.window.showQuickPick([
        ...(repo.inputBox.value ? [{ label: '保留已有提交说明', prefix: '' }] : []),
        { label: 'feat · 新增功能', prefix: 'feat: ', description: '例如：feat: 新增今日提交状态面板' },
        { label: 'fix · 修复问题', prefix: 'fix: ', description: '例如：fix: 修复提醒时间显示错误' },
        { label: 'docs · 文档更新', prefix: 'docs: ', description: '例如：docs: 补充插件安装说明' },
        { label: 'refactor · 代码重构', prefix: 'refactor: ' },
        { label: 'test · 测试完善', prefix: 'test: ' },
        { label: 'chore · 维护调整', prefix: 'chore: ' },
        { label: '自定义说明', prefix: '' }
      ], { title: '选择提交说明模板', placeHolder: '选择类型后填写中文摘要，也可自定义' });
      if (!template) return;
      const message = await vscode.window.showInputBox({
        title: `提交到 ${title(repo)} · ${repo.state.HEAD?.name || '新分支'}`,
        prompt: '填写中文提交说明；下一步会确认分支和文件清单。取消不会暂存新文件。',
        value: template.prefix ? template.prefix + repo.inputBox.value.replace(/^[a-z]+:\s*/i, '') : repo.inputBox.value,
        placeHolder: template.prefix + '用中文描述本次修改',
        ignoreFocusOut: true,
        validateInput: value => value.trim() && !/^[a-z]+:\s*$/i.test(value.trim()) ? undefined : '请填写具体的提交说明'
      });
      if (!message?.trim()) return;
      if (!await vscode.workspace.saveAll(false)) throw new Error('部分文件未能保存，请保存后重试。');
      await repo.status();
      assertResolved(repo);
      // Do not accidentally include staging performed by another UI during the prompt.
      if (selected && repo.state.indexChanges.length) throw new Error('暂存区已变化，请重新提交并检查暂存文件。');
      if (!selected && !repo.state.indexChanges.length) throw new Error('暂存区已清空，请重新选择文件。');
      if (originalHead !== headKey()) throw new Error('当前分支或提交已变化，请重新确认后提交。');
      if (originalIndex !== await repo.diff(true)) throw new Error('暂存内容已变化，请重新检查后提交。');
      const included = selected ? selected.map(item => item.change) : [...repo.state.indexChanges];
      const includedKeys = new Set(included.map(change => change.uri.toString()));
      const excluded = selected ? changes(repo.state).filter(change => !includedKeys.has(change.uri.toString())).length
        : new Set([...repo.state.workingTreeChanges, ...repo.state.untrackedChanges].map(change => change.uri.toString())).size;
      async function filesSnapshot() {
        if (!selected) return '';
        return JSON.stringify(await Promise.all(included.map(async change => {
          try {
            const content = await vscode.workspace.fs.readFile(change.uri);
            return [change.uri.toString(), createHash('sha256').update(content).digest('hex')];
          } catch (error) {
            if (error.code === 'FileNotFound' || error.code === 'ENOENT') return [change.uri.toString(), 'deleted'];
            throw new Error(`无法读取 ${path.relative(repo.rootUri.fsPath, change.uri.fsPath)}，请在源代码管理中暂存具体文件后重试。`);
          }
        })));
      }
      const fileState = await filesSnapshot();
      const confirmation = await vscode.window.showInformationMessage('确认本次提交', {
        modal: true,
        detail: [
          `仓库：${title(repo)}`, `路径：${repo.rootUri.fsPath}`,
          `分支：${repo.state.HEAD?.name || (repo.state.HEAD?.commit ? '分离 HEAD' : '首次提交')}`,
          `提交说明：${message.trim()}`, '',
          `${selected ? '将按完整文件暂存并提交' : '仅提交已暂存内容，保留部分暂存'}（${included.length} 个文件）：`,
          ...included.map(change => `• ${path.relative(repo.rootUri.fsPath, change.uri.fsPath)}`), '',
          `${excluded} 个文件的${selected ? '未选中' : '未暂存'}改动不会提交。`,
          '本次只提交到本地，成功后可选择立即推送。'
        ].join('\n')
      }, '确认提交', '返回查看改动');
      if (confirmation === '返回查看改动') { await vscode.commands.executeCommand('workbench.view.scm'); return; }
      if (confirmation !== '确认提交') return;
      await repo.status();
      assertResolved(repo);
      if (originalHead !== headKey() || originalIndex !== await repo.diff(true) || fileState !== await filesSnapshot()) {
        throw new Error('确认期间分支、暂存内容或所选文件已变化，请重新检查后提交。');
      }
      if (selected) await repo.add(selected.map(item => item.change.uri.fsPath));
      if (selected) {
        await repo.status();
        if (originalHead !== headKey() || fileState !== await filesSnapshot() || repo.state.indexChanges.some(change => !includedKeys.has(change.uri.toString()))) {
          throw new Error('暂存期间仓库内容已变化，请检查暂存区后重新提交。');
        }
      }
      await repo.commit(message.trim(), { all: false, postCommitCommand: null });
      repo.inputBox.value = '';
      try { await repo.status(); }
      catch (error) { output.appendLine(`本地提交已成功，刷新状态失败：${error.message}`); }
      return { repo, branch: repo.state.HEAD?.name, commit: repo.state.HEAD?.commit };
    }

    async function offerPush(result) {
      if (!result) return;
      const action = await vscode.window.showInformationMessage(`Git Daily · ${title(result.repo)}：已提交到本地。`, '立即推送', '稍后');
      if (action !== '立即推送') return;
      await operate(result.repo, '推送', async repo => {
        if (repo.state.HEAD?.name !== result.branch || repo.state.HEAD?.commit !== result.commit) {
          throw new Error('分支或提交已变化，请在面板中检查后重新推送');
        }
        await push(repo);
      });
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

    async function showReminder(repo, savedKey, record) {
      const count = changes(repo.state).length;
      const action = await vscode.window.showInformationMessage(
        `Git Daily · ${title(repo)}：${count ? `还有 ${count} 个文件未提交` : repo.state.HEAD?.ahead ? '有本地提交待推送' : '到每日检查时间了'}。`,
        { modal: config().get('reminderStyle', 'notification') === 'dialog' },
        '查看改动', '提交代码', '推送', '稍后提醒', '今天忽略'
      );
      if (disposed) return;
      if (action === '稍后提醒') {
        const latest = context.workspaceState.get(savedKey, {});
        if (latest.day === record.day && latest.time === record.time) {
          await context.workspaceState.update(savedKey, { ...record, snoozeUntil: Date.now() + config().get('snoozeMinutes', 30) * 60000 });
        }
      } else if (action === '查看改动') await vscode.commands.executeCommand('workbench.view.scm');
      else if (action === '提交代码') await offerPush(await operate(repo, '提交代码', commit));
      else if (action === '推送') await operate(repo, '推送', push);
    }

    async function checkReminders() {
      if (checking || disposed || !config().enabled || !vscode.window.state.focused || !vscode.workspace.isTrusted) return;
      checking = true;
      try {
        for (const repo of api.repositories) {
          if (disposed) break;
          const pendingKey = `${key(repo)}:${config().reminderTime}`;
          if (busy.has(key(repo)) || pendingReminders.has(pendingKey)) continue;
          try {
            const savedKey = `reminder:${key(repo)}`;
            const now = new Date();
            const saved = context.workspaceState.get(savedKey, {});
            // Refresh before checking dirty state: Git's initial cache can still be empty.
            await repo.status();
            if (!reminderDue(now, config(), saved, repo.state)) continue;
            const record = { day: dayKey(now), time: config().reminderTime };
            pendingReminders.add(pendingKey);
            await context.workspaceState.update(savedKey, record);
            output.appendLine(`[${now.toISOString()}] ${title(repo)} 已发送提醒；样式=${config().get('reminderStyle', 'notification')}。普通通知若未显示，请检查 VS Code 免打扰或改用 dialog。`);
            // Notification promises resolve on user interaction, not when the toast appears.
            // Do not let an unattended toast block checks for all other repositories.
            void showReminder(repo, savedKey, record)
              .catch(async error => {
                const latest = context.workspaceState.get(savedKey, {});
                if (latest.day === record.day && latest.time === record.time && !latest.snoozeUntil) {
                  await context.workspaceState.update(savedKey, undefined);
                }
                output.appendLine(`提醒操作失败：${error.message}`);
              })
              .finally(() => { pendingReminders.delete(pendingKey); refresh(); });
            refresh();
          } catch (error) {
            pendingReminders.delete(pendingKey);
            output.appendLine(`${title(repo)} 提醒检查失败：${error.message}`);
          }
        }
      } catch (error) { output.appendLine(`提醒检查失败：${error.message}`); }
      finally { checking = false; }
    }

    async function reminderStatus(candidate) {
      try {
        const repo = await selectRepository(candidate);
        if (!repo) return;
        await repo.status();
        const now = new Date();
        const saved = context.workspaceState.get(`reminder:${key(repo)}`, {});
        const reason = !vscode.window.state.focused ? '窗口不在前台' : pendingReminders.has(`${key(repo)}:${config().reminderTime}`) ? '已有提醒等待处理，请查看通知中心' : reminderReason(now, config(), saved, repo.state) || '触发条件已满足，将在下一次检查时提醒';
        const details = [
          `仓库：${repo.rootUri.fsPath}`, `扩展宿主时间：${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
          `设定时间：${config().reminderTime}`, `启用：${config().enabled}；仅工作日：${config().weekdaysOnly}；仅有改动：${config().onlyWhenDirty}`,
          `已保存改动：${changes(repo.state).length}；待推送：${repo.state.HEAD?.ahead || 0}`,
          `上次提醒：${saved.day || '无'} ${saved.time || ''}`, `状态：${reason}`,
          '普通通知受 VS Code 免打扰及单个扩展通知过滤影响；可设置 gitDaily.reminderStyle 为 dialog。'
        ].join('\n');
        output.appendLine(details);
        await vscode.window.showInformationMessage('Git Daily · 提醒诊断', { modal: true, detail: details }, '知道了');
        return details;
      } catch (error) { await report(error); }
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
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitDaily')) { refresh(); void checkReminders(); } }),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) { refresh(); void checkReminders(); } }),
      vscode.commands.registerCommand('gitDaily.openDashboard', async () => {
        await vscode.commands.executeCommand('gitDaily.repositories.focus');
        await Promise.all(api.repositories.map(repo => operate(repo, '刷新', selected => selected.status())));
      }),
      vscode.commands.registerCommand('gitDaily.commit', async repo => offerPush(await operate(repo, '提交代码', commit))),
      vscode.commands.registerCommand('gitDaily.push', repo => operate(repo, '推送', push)),
      vscode.commands.registerCommand('gitDaily.sync', repo => operate(repo, '同步', async selected => {
        await syncRepository(selected);
        vscode.window.showInformationMessage('同步完成。');
      })),
      vscode.commands.registerCommand('gitDaily.fetch', repo => operate(repo, '获取远程状态', selected => selected.fetch({ all: true }))),
      vscode.commands.registerCommand('gitDaily.refresh', () => Promise.all(api.repositories.map(repo => operate(repo, '刷新', selected => selected.status())))),
      vscode.commands.registerCommand('gitDaily.review', () => vscode.commands.executeCommand('workbench.view.scm')),
      vscode.commands.registerCommand('gitDaily.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'gitDaily')),
      vscode.commands.registerCommand('gitDaily.testReminder', () => vscode.window.showInformationMessage(
        'Git Daily · 测试提醒',
        { modal: true, detail: '看到这个对话框说明插件可以显示提醒。此测试不受提醒时间、仓库改动和当天提醒记录限制，也不会消耗今天的提醒。自动提醒若不出现，请运行“Git Daily: 提醒诊断”；若普通通知被隐藏，可将提醒样式改为 dialog。' },
        '知道了'
      )),
      vscode.commands.registerCommand('gitDaily.reminderStatus', reminderStatus)
    );
    api.repositories.forEach(watch);
    const timer = setInterval(() => { refresh(); void checkReminders(); }, 30000);
    context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); subscriptions.forEach(item => item.dispose()); } });
    refresh();
  }

  return { activate };
}

module.exports = { ...createExtension(require('vscode')), createExtension };
