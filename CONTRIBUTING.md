# 贡献指南

English contributions are welcome. Please follow the same rules below.

## 提 issue

- 请用 [issue 表单](https://github.com/rumoii/streamfirefly/issues/new/choose)提交，并按要求填写版本、浏览器和复现步骤。
- 先把扩展和本地助手都更新到最新版，确认问题仍然存在。
- 一个 issue 只说一个问题，提交前先搜索已有 issue，包括已关闭的。
- 报告问题时附上诊断报告：扩展设置页 →“常规 → 问题反馈”→“导出诊断报告”。issue 是公开的，提交前请检查报告里的网页地址和标题。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 提 PR

- 大的改动请先开 issue 讨论，避免做了之后方向不合适。
- 一个 PR 只做一件事。几件不相关的事混在一起的 PR，会请你拆开再提交。
- 构建和测试方法见 README 的[从源码构建](README.md#从源码构建)和[开发](README.md#开发)。
- 提交前至少运行：

  ```powershell
  npm run typecheck
  npm run validate:extension
  npm run test:unit
  ```

  改了 `native-host/` 的话，再运行：

  ```powershell
  cargo test --manifest-path native-host/Cargo.toml
  npm run test:native
  ```

- 按 PR 模板填写改了什么、为什么改、实际运行了哪些命令，以及 AI 使用说明。
- PR 打开或更新后会自动运行检查：改了扩展或界面代码时跑类型检查、扩展校验和单元测试，改了 `native-host/` 时再跑本地助手测试，只改文档时跳过。结果显示在 PR 页面底部；第一次贡献的 PR 需要维护者批准后才会开始运行。

## 依赖升级

- `package.json` 里的依赖使用精确版本。
- 用 `npm install <包>@<版本>` 升级，让 npm 重新生成 `package-lock.json`，不要手改 lock 文件。
- 不要用 `overrides` 单独覆盖某个子包。同一组的包要一起升级，例如 `vue` 和全部 `@vue/*`。
- 升级后跑完上面的检查命令。

## 使用 AI 的说明

可以用 AI 辅助写代码、查问题或整理文字，但提 issue 和 PR 时必须如实说明：

- 写明有没有用 AI。用了的话，写出具体的工具和模型版本，例如 `chatgpt-6.1-sol`，不要只写“AI”或“ChatGPT”；再写明用在了哪里，比如发现问题、写代码、写测试、写说明。issue 表单和 PR 模板里都有对应的位置。
- AI 发现的问题，提交前请自己确认能复现，或者能在代码里指出具体位置；还没有确认的，请注明。
- AI 写的代码，提交人必须自己读过全部改动、在本地验证过，并在 PR 里写明验证方式。
- 没有如实说明，或者没有验证过的自动化 PR，会直接关闭。

AI tools are welcome, but disclose them: name the exact tool and model version (for example `chatgpt-6.1-sol`) and what it was used for. Undisclosed or unverified AI-generated PRs will be closed.

## 不接受的改动

- 绕过 DRM 或其他内容保护
- 规避平台限制，例如让 Chrome 应用商店版识别 YouTube

## 许可

提交贡献即表示你同意按本项目的 [MIT 许可](LICENSE)发布你的贡献。
