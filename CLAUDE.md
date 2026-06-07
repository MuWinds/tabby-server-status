# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands（可执行命令）

```sh
# 安装依赖（Tabby 核心包不在 npm 公开仓库，须用 legacy-peer-deps 跳过 peer 检查）
npm install --legacy-peer-deps

# 生产构建（产物：dist/index.js）
npm run build

# 开发模式（--watch 自动重构建）
npm run watch

# 纯 TypeScript 类型检查（不产出 JS，用于 CI / 提交前检查）
npx tsc --noEmit -p tsconfig.json

# 运行单元测试（parser + format 纯函数）
npx tsc -p tsconfig.test.json
node tests-build/tests/run.js

# 一键：类型检查 + 构建 + 测试
npx tsc --noEmit -p tsconfig.json && npm run build && npx tsc -p tsconfig.test.json && node tests-build/tests/run.js
```

## Project Structure（项目结构）

```
src/
  index.ts                         # NgModule 入口（export default 是 Tabby 硬性约定），构造时调用 injector.start()
  probe.ts                         # 跨平台 POSIX shell 脚本，用 D="$" 技巧避免 JS 模板插值与 shell 变量冲突
  collector.ts                     # probeOnce()：打开 SSH channel→requestExec→收集 stdout；通过 export type 重导出 ServerStatus
  parser.ts                        # 纯函数 parseProbeOutput()：按 ===KEY=== 分隔解析输出；ServerStatus 接口每字段有 JSDoc
  format.ts                        # 纯函数：formatUptime、formatRate、formatPercent、sparkline（Unicode 块字符 ▁-█）
  statusBar.component.ts           # Angular 组件（inline HTML 模板），字号从 ConfigService 读取以跟随 Tabby 设置
  statusBar.component.scss         # 所有 class 强制 sb- 前缀，避免与 Bootstrap 栅格系统冲突
  statusBarInjector.service.ts     # DOM 注入器：位置匹配→appendChild→inline style 定位(z-index:1000)→ResizeObserver 同步 padding
  shims.d.ts                       # tabby-core/tabby-ssh/russh 的类型 stub（仅覆盖本项目用到的 API，按需扩展）
tests/
  run.ts                           # 纯函数单测（无需 jest/mocha，直接 node 跑）
webpack.config.js                  # UMD 输出；所有 tabby-* / @angular / rxjs 标记为 external
tsconfig.json                      # 主构建用
tsconfig.test.json                 # 测试用（只编译 format/parser/probe，排除依赖 tabby 的模块）
```

**架构分层**：

1. **数据层**（probe.ts → collector.ts → parser.ts）：远端脚本 → SSH channel → 分隔符解析 → `ServerStatus` 接口
2. **展示层**（format.ts → statusBar.component.ts）：纯函数格式化 + Angular 组件渲染 sparkline 和历史环形缓冲
3. **注入层**（statusBarInjector.service.ts → index.ts）：监听 `tabOpened$` / `activeTabChange$`，按位置匹配 `<ssh-tab>` DOM 元素并动态挂载组件

## Code Style（代码示例）

**遵循 [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)**，以下关键规则：

- **禁止 default export**（index.ts 除外——Tabby 插件加载器要求 NgModule 必须是 default export）
- **所有 public API 使用 JSDoc**：`/** ... */` 格式，含 `@param`、`@returns`、`@fileoverview`
- **`import type` 用于纯类型导入**：如 `import type { ServerStatus } from './parser'`
- **`export type` 用于类型重导出**：如 `export type { ServerStatus } from './parser'`
- **禁止 `any`**：用 `unknown` 或具体类型替代；duck-typing 时用 `as unknown as { method?: () => T }`
- **构造函数参数加 `readonly`**：`constructor (private readonly app: AppService)`
- **JSDoc 文件头**：每个 `.ts` 文件顶部有 `@fileoverview` 描述该文件职责

**Angular 模板用 inline HTML 字符串**（不要 pug）：pug 在部分 Angular 绑定语法（`[attr]`、`ng-container` + `*ngIf`）下编译输出可能不正确。

**Shell 脚本（probe.ts）**：用 JS 模板字符串拼接跨平台 POSIX shell，避免 `${...}` 与 shell 变量展开冲突。关键技巧——用单字符变量 `D` 嵌入字面 `$`：

```ts
const D = '$'
// 模板里用 ${D} 拼出 shell 变量展开
// awk 程序必须用单引号包裹，让 shell 不抢先展开 $N
```

**所有 CSS class 强制 `sb-` 前缀**：`.sb-root`、`.sb-row`、`.sb-item`。因为 Tabby 通过 ng-bootstrap 全局加载 Bootstrap，裸 `.row` / `.item` 会与栅格系统冲突（导致每个 item 占满一行）。

**字号跟随 Tabby 终端设置**：在 `ngOnInit` 里读 `ConfigService.store.terminal.fontSize`，通过 inline style 应用到组件根元素。订阅 `config.changed$` 实时同步。子元素用 `em` 按比例缩放。

**DOM 注入**：组件通过 `ComponentFactoryResolver` 动态创建并 append 到 `<ssh-tab>`。用 inline style（`position: absolute; bottom: 0; z-index: 1000`）浮在 xterm canvas 之上，并用 `ResizeObserver` 同步宿主 `padding-bottom`。

**JSDoc 注释示例**（遵循 Google TS Style 的 `@fileoverview` + `@param` + `@returns` 规范）：

```ts
/**
 * @fileoverview 纯函数模块：将远端 probe 脚本的文本输出解析为结构化的
 * ServerStatus 对象。该模块无副作用、无外部依赖，便于 Node.js 单测。
 */

/** 一次远端服务器探针采样的结构化结果。 */
export interface ServerStatus {
    /** 服务器 IP 地址 */
    ip: string
    /** CPU 使用率百分比（0-100 整数）；不可用时为 null */
    cpuPercent: number | null
}

/**
 * 解析 probe 脚本的文本输出，构建 ServerStatus 对象。
 * @param raw 远端 probe 脚本的原始文本输出
 * @param previous 上一次采样结果，用于计算速率差；首次采样传 null
 * @returns 结构化的服务器状态快照
 */
export function parseProbeOutput(
    raw: string,
    previous: ServerStatus | null,
): ServerStatus { ... }
```

**禁止 `any` —— duck-type 模式**（Google 规则：用 `unknown` / 具体类型替代 `any`）：

```ts
// ❌ 禁止
const visit = (t: any) => { ... }

// ✅ 用 duck-type：as unknown as { method?: () => T }
const split = t as unknown as { getAllTabs?: () => BaseTabComponent[] }
if (split.getAllTabs) {
    for (const child of split.getAllTabs()) visit(child)
}
```

**default export 的例外**：`src/index.ts` 使用 `export default class ServerStatusModule`——这是 Tabby 插件加载器的硬性要求，与 Google "禁止 default export" 规则冲突。已在文件头 JSDoc 中注明原因。其他所有模块一律使用命名导出。

## Git Workflow（版本与提交规范）

仓库目前不在 git 管理下（`git status` 为空）。如要初始化，建议：

- 提交粒度：一个逻辑改动一次提交
- 提交信息格式：`<type>: <简短描述>`
  - `feat:` 新功能
  - `fix:` 修复 bug
  - `refactor:` 结构调整
  - `chore:` 构建/依赖变更

## Boundaries（操作边界）

**本项目是 Tabby 插件**，不是独立应用：

- **不要修改 Tabby 源码**：插件通过 `peerDependencies` + webpack `externals` 引用 tabby-core/tabby-ssh，运行时由宿主 Tabby 提供这些模块。我们只产出 `dist/index.js`。
- **不要引入额外运行时依赖**：所有 npm 依赖均为 devDependencies（webpack/ts-loader/css-loader 等构建工具）。运行时依赖（@angular/core、rxjs、tabby-core、russh）由 Tabby 提供，列为 peerDependencies。
- **不要假设服务器端有特殊工具**：数据采集脚本只使用 POSIX shell 标准命令（`awk`、`ps`、`top`、`ip`、`netstat`、`sysctl`），不依赖 Python/ruby/curl 等可选工具。
- **sparkline 用 Unicode 块字符**：`▁▂▃▄▅▆▇█`。不要引入 SVG/canvas 图表库——0 额外依赖、自动跟随终端字号、无渲染性能开销。
- **DOM 操作在 injector service 中集中管理**：组件本身不操作宿主 DOM，由 `statusBarInjector.service.ts` 统一处理定位、z-index、ResizeObserver、padding 同步和销毁清理。
- **tabby-core/tabby-ssh/russh 的 stub 是极简的**：`src/shims.d.ts` 中的类型声明仅覆盖本项目实际使用的 API，不是完整映射。如果未来需要新的 API，在 shims 中按需扩展。
- **所有新代码必须有 JSDoc**：新增 public 函数/类/接口必须有 `@fileoverview`（文件级）或 `@param`/`@returns`（函数级）JSDoc 注释。private 辅助函数也应有简要 JSDoc。`catch (e)` 必须使用 `catch (e: unknown)`。
