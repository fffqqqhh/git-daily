# 线上更新与发布

本仓库已配置发布者 `fffqqqhh` 及 Trusted Publishing，`v0.1.2` 标签的自动发布任务已成功上传 0.1.2。市场验证及可安装状态以 [市场页面](https://marketplace.visualstudio.com/items?itemName=fffqqqhh.git-daily) 为准。由 VS Code 负责检查和安装后续更新。

以下一次性配置步骤供重新部署时参考；当前仓库无需重复创建发布者、策略或 `v0.1.2` 标签，后续直接按“以后如何发布”更新版本。

## 一次性配置（仓库所有者）

1. 使用自己的 Microsoft 账号登录 [Marketplace 发布者管理](https://marketplace.visualstudio.com/manage)。登录、账号验证及任何条款由账号所有者本人完成。
2. 创建或选择发布者，ID 优先使用 `fffqqqhh`，与 `package.json` 的 `publisher` 一致。该 ID 只是当前项目配置，不代表已注册或一定可用；不要选择他人的发布者。如果必须更换 ID，先修改配置再打包，这会改变插件身份，已有 VSIX 用户需安装新身份的市场版一次。
3. 在该发布者中打开 **Trusted Publishing → Create**，配置：

   | 字段 | 内容 |
   | --- | --- |
   | Policy name | Git Daily releases |
   | Repository owner | `fffqqqhh` |
   | Repository | `git-daily` |
   | Workflow | `publish.yml` |
   | Environment | 留空（当前工作流未使用 environment） |

   创建此策略会授权此仓库的发布工作流代表该发布者发布扩展，请由所有者确认后配置。工作流使用短期 OIDC 凭证，无需把个人令牌放入代码、聊天或仓库。
4. 确认 GitHub 仓库 Actions 可正常运行，主分支构建已通过。
5. 首次发布：将版本号设为要上架的版本（当前为 `0.1.2`），创建同名版本标签 `v0.1.2` 并推送。只在确实准备发布时执行这一步，推送标签会触发上线。
6. 等待 Actions 的 publish 任务完成及 Marketplace 处理完成，在市场中核对 `fffqqqhh.git-daily` 的版本、描述和可安装状态。

## 以后如何发布

开发环境需要 Node.js 22+，推荐 Node.js 24。

```sh
npm ci
npm test
npm run check
npm version patch
git push origin main
git push origin --follow-tags
```

`npm version patch` 会更新版本及锁文件，并创建版本提交和标签。请在干净的主分支执行，检查本次要发布的更改后再推送。工作流只在 `v*` 标签上发布，并强制标签与 `package.json` 版本一致；普通提交、PR 和手动运行只测试和生成安装包。

测试失败或标签不匹配时不会发布。发布任务上传的是 build 任务实际测试、打包并保存的同一份 VSIX。不要覆盖旧版本标签；修复后使用新的版本号发布。

## 用户如何接收更新

上架后，用户可在 VS Code 扩展面板搜索 `@id:fffqqqhh.git-daily` 安装，并为该扩展开启 **Auto Update / 自动更新**。

**已有 VSIX 用户需要特别检查**：VS Code 对通过 VSIX 安装的扩展默认关闭自动更新。保持相同发布者和插件名，在市场版上线后，打开 Git Daily 的扩展详情或右键菜单，启用该扩展的 Auto Update。若仍未关联市场，可从市场安装该扩展一次。之后不必手动下载和替换安装包，更新后可能需要按提示重启扩展宿主。

全局关闭自动更新、禁用扩展、网络问题或组织策略也可能阻止更新。自动更新并不承诺发布后立即生效，VS Code 有自己的检查和安装延迟。

仅把源码推送到 GitHub 或生成 VSIX，不会让客户端自动更新。当前流程面向微软官方 VS Code；其他编辑器的扩展市场与更新行为需要分别验证。

## 参考

- [官方发布与 Trusted Publishing 指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [官方扩展安装与自动更新说明](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)
