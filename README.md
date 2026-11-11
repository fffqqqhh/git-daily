# Git Daily · 每日提交助手

每天提醒你收尾代码工作，在 VS Code 的源代码管理侧边栏完成提交、推送和同步。

## 功能

- 每天默认 **17:30** 提醒；支持更改时间、仅工作日、稍后提醒、今天忽略。
- 默认有未提交改动或待推送提交才提醒；提醒记录按工作区和仓库保存，重载窗口不会当天重复提醒。
- 多仓库分别显示分支、改动数量、待推送/待拉取数量。
- 已有暂存内容时仅提交暂存区，保留部分暂存；没有暂存时可多选文件，按完整文件暂存并提交。
- 推送复用 VS Code 内置 Git 的认证；第一次推送可选远程并设置上游分支。
- 同步为先拉取、再推送；拉取失败立即停止。同步前要求工作区干净，冲突需要先处理。
- 获取远程状态、打开原生改动审查界面、状态栏入口、错误日志。

## 安装和使用

需要桌面版 VS Code 1.95+、Git，以及已启用的内置 Git 扩展。主要面向本地仓库，不支持 vscode.dev 中的虚拟仓库。

1. 下载本项目生成的 `git-daily-0.1.0.vsix`。
2. 在 VS Code 扩展面板右上角选择 **… → 从 VSIX 安装**，选择该文件。
3. 打开自己的 Git 仓库，点击左侧“源代码管理”，展开 **Git Daily · 每日提交助手**。
4. 点击“查看改动”审查差异，再选择“提交代码”“推送”或“同步”。

也可在命令面板搜索 `Git Daily`。点面板顶部齿轮设置提醒，或者在设置中搜索 `gitDaily`。

```json
{
  "gitDaily.enabled": true,
  "gitDaily.reminderTime": "17:30",
  "gitDaily.weekdaysOnly": false,
  "gitDaily.onlyWhenDirty": true,
  "gitDaily.snoozeMinutes": 30
}
```

提醒依赖扩展宿主运行，VS Code 关闭或电脑休眠期间不会提醒。在当天提醒时间之后打开 VS Code，会检查并补提醒；只在窗口获得焦点时提醒，检查间隔约 30 秒。使用扩展宿主的本地时区，远程开发时可能是远程主机的时区。同一仓库在多个不同工作区打开时，提醒记录独立。

改动计数来自 Git，尚未保存的编辑器内容只有保存后才会进入计数。提交前会保存已命名文件；临时未命名文件请先自行保存到仓库。没有暂存区时选择文件会提交这些文件的完整内容。需要部分提交时，请先在原生源代码管理界面暂存部分内容。提交失败时保留暂存区，方便修复后重试。

推送和同步都需要你点击执行；提交不会触发 Git 设置中的自动推送。同步采用内置 Git 的 pull 行为（遵循 Git/VS Code 配置），可能产生合并或变基冲突，请按原生源代码管理提示处理。远程数量基于最近获取的状态，可点击“获取远程状态”刷新。未关联上游时先使用“推送”；无远程时先在原生源代码管理中配置远程。

## 开发

本项目使用 JavaScript（CommonJS）与 VS Code Extension API，无运行时第三方依赖，不需要编译。

```sh
npm test
npm run check
npm run package
```

用 VS Code 打开项目目录，按 **F5** 启动扩展开发窗口，在新窗口打开测试仓库。

自动化测试覆盖提醒调度、持久化去重、延后提醒、同步顺序与失败保护，以及模拟 VS Code 下的提交交互。首次安装后建议用测试仓库验证实际凭证、Git hooks 和远程服务器策略。

手工验收：设置提醒时间为当前分钟前一分钟，修改并保存测试文件，等待提醒；稍后提醒后重载窗口检查保留；验证部分暂存提交、首次推送设置上游、两端提交后的同步，以及冲突时停止。

## 实现参考

- [VS Code 内置 Git API](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts)
- [VS Code 扩展 API](https://code.visualstudio.com/api/references/vscode-api)
- [扩展打包说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

MIT License。
