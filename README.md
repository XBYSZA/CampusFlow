# CampusFlow

把校园信息变成可解释的行动计划 —— 面向大学生的校园事务智能规划与执行助手。

## 当前阶段

S7 · 全局决策解释抽屉 + 产品演示打磨

## S7 当前能力

- 全局「决策解释抽屉」：Inbox / Tasks / Schedule 三个页面共用同一条决策解释链，不设独立 /explain 页面
- 统一聚合 API：`GET /api/decisions/task/[taskId]`，把一个任务的 Source / Evidence / DecisionLog / SubTask / Schedule / Conflict 聚合为一条 `DecisionTimeline`
- 阶段缺失自动跳过：任务未拆解或未发生过重排时，对应阶段不显示，接口不报错
- AI 调用上下文（provider / model / promptVersion / 耗时）仅作展示与调试，**不是审计证据**
- 全局统一页面壳（左侧导航：智能收件箱 / 任务板 / 智能日程），首页为三个入口卡片

### 三种角色一眼可辨

| 角色 | 负责 | 对应阶段 |
| --- | --- | --- |
| AI | 信息理解、任务拆解 | EXTRACT / DECOMPOSE |
| 规则引擎 | 时间排期、冲突检测、重排 | PLAN / REPLAN |
| 人工 | 确认提取、拆解、计划、重排 | 每个正式结果写入前 |

抽屉中每个阶段都带角色徽标与颜色区分，评委可以直接看出「不是所有事情都扔给 LLM」。

### DecisionLog → DecisionTimeline

S2-S6 各阶段写入的 `DecisionLog`（EXTRACT / DECOMPOSE / PLAN / REPLAN）是结构化留痕；S7 在服务端把它们聚合成统一的 `DecisionTimeline` 展示契约（Zod 校验）：

- EXTRACT：识别出的任务字段 + evidence quote + 原文上下文 + AI 调用上下文
- DECOMPOSE：①②③ 子任务顺序、预计耗时与依赖关系（纯文本展示，不引入 React Flow）
- PLAN：排期策略 + 每个计划块的时间段与 rationale（取自 DecisionLog / Schedule，不重新生成）
- REPLAN：触发冲突 → 固定占用方 → 原计划（已取消，保留历史）→ 新计划（已确认）的 old → new 对照

### 为什么不让 LLM 生成排期解释

排期解释必须经得起复核：时间段、课程占用、依赖就绪时间都是数据库中的事实。如果让 LLM 临场编理由，可能出现与真实约束不一致的「合理化幻觉」。因此 PLAN / REPLAN 阶段的所有解释均直接取自 `DecisionLog.evidence` 与 `Schedule.rationale`——这些文字在排期发生时由确定性规则引擎根据真实约束生成，S7 只做展示，不做再创作。

### S7 验证

`npm run s7:verify` 在独立临时 SQLite 库上运行 17 项检查：来源聚合、evidence quote、四类阶段的角色映射、CANCELLED / CONFIRMED 历史区分、冲突 old → new 映射、无来源 / 无日志 / 阶段缺失容错、aiContext 非审计证据、契约校验与精确清理，全程不触碰开发数据库。

## S4 当前能力

- `/schedule` 周视图：横向 周一 → 周日，纵向 08:00-22:00，CSS Grid + 绝对定位自绘（不引入 FullCalendar）
- 固定课程块、正式日程块、预览块三种视觉层级；点击任意块查看 rationale
- 「生成计划」：只生成预览，不写数据库；预览块为虚线条
- 「确认此计划」：服务端重新查询数据库并逐条复核约束，事务写入 `Schedule(status=CONFIRMED)` 与 `DecisionLog(PLAN)`
- 未能安排的对象进入「未安排项目」列表并给出具体原因（缺截止时间 / 截止已过 / 时段不足 / 依赖未满足）
- 重复确认同一对象会被拒绝（409），不会生成第二套计划
- 不做 S5 的冲突制造、自动重排与拖拽

### PlanningEngine 架构

```
Task / SubTask / Dependency / Course / 已有 Schedule
        ↓ loadPlanningContext（每次预览/确认都重新读库）
    PlanningItem[]
        ↓ buildPlanningItems（情况 A/B 去重、跳过 DONE 与已排期）
   确定性 PlanningEngine（纯函数）
        ↓
     PlanPreview（Zod 校验）
        ↓ 用户人工确认
   服务端二次校验（owner/时间/课程/日程/依赖/总时长等）
        ↓ Prisma transaction
 Schedule(CONFIRMED) + DecisionLog(PLAN)
```

- `src/lib/time.ts`：Asia/Shanghai 时间工具（固定 UTC+8，无日期库）
- `src/lib/planning/contract.ts`：PlanningItem / PlanBlock / PlanPreview / confirm 入参 Zod 契约
- `src/lib/planning/engine.ts`：纯函数贪心排期引擎，不访问数据库、不调用 LLM
- `src/lib/services/schedule.ts`：读取上下文、生成预览、确认校验与事务写入

### 为什么不用 LLM 直接决定时间

LLM 擅长理解语义，但不能保证时间约束绝对正确。排期必须可测试、可复现、可解释：
同一输入必须产生同一结果。因此 S4 的时间决策全部由确定性规则引擎完成；
后续接入真实 LLM 时，LLM 可以负责解释排期原因，但不能绕过约束引擎。

### 时间约束

- 统一时区 Asia/Shanghai（UTC+8，无夏令时）
- 可安排区间 08:00-22:00，最小粒度 30 分钟
- 不排到过去，不超过 `Task.deadline`
- 不与固定课程重叠、不与已有有效日程重叠
- 区间语义为半开区间 `[start, end)`：10:00-11:00 与 11:00-12:00 不算冲突

### 排期规则

- 情况 A：Task 无 SubTask → 排 Task 本身
- 情况 B：Task 已有 SubTask → 只排 SubTask，父 Task 不重复排
- 已完成（DONE）对象、已有有效日程的对象不再安排
- 缺截止时间 / 缺预计耗时的对象进入 unscheduled 并写明原因
- 排序：deadline 早 → priority HIGH > MEDIUM > LOW → ownerId（保证确定性）
- 长任务拆块：单块 30~120 分钟，总时长按「预计耗时向上取整到 30 分钟」核对
- 依赖：后续子任务不得早于所有前置完成时间；多个前置须全部完成
- 找不到合法时段时进入 unscheduled，不强行安排

### preview → human confirm → database

1. `POST /api/schedule/preview`：只读数据库，返回 `PlanPreview`，不写任何记录
2. 前端展示虚线预览块，用户点击「确认此计划」
3. `POST /api/schedule/confirm`：重新查询 Task/SubTask/Course/Schedule，逐条校验 owner 合法性、时长粒度、过去/截止/范围、课程与日程重叠、块间重叠、依赖顺序、总时长与重复确认
4. 校验通过后单事务写入 `Schedule` 与 `DecisionLog(PLAN)`，任一步失败整体回滚

## S6 当前能力

- 在不改动 Inbox / Tasks 业务逻辑的前提下新增 `RealAIProvider`，任务提取与任务拆解可由真实大模型完成
- `MockAIProvider` 保留为开发、离线演示与断网兜底，`AI_PROVIDER=mock` 时二阶段验证脚本仍全绿
- 排期 / 冲突检测 / 重排时间决策**完全不经过 LLM**，仍由 S4/S5 的确定性引擎完成

### Provider 结构

```
                 ┌─ MockAIProvider（规则引擎，默认）
AIProvider ──────┤
                 └─ RealAIProvider（OpenAI-compatible HTTP）
        ↑
 Inbox Service / Tasks Service（只依赖接口，不依赖某家供应商）
```

### 两种模式

```bash
# 1) Mock 模式（默认，无需任何密钥）
AI_PROVIDER=mock
npm run dev

# 2) Real 模式（OpenAI-compatible 接口）
AI_PROVIDER=real
REAL_LLM_BASE_URL=https://<your-endpoint>/v1
REAL_LLM_API_KEY=<your-key>
REAL_LLM_MODEL=<your-model>
REAL_LLM_TIMEOUT_MS=30000   # 可选，默认 30000
npm run dev
```

- 只读取服务端环境变量，不使用 `NEXT_PUBLIC_` 前缀，API Key 不会返回浏览器
- `AI_PROVIDER=real` 但缺少必需配置时返回 `AI_CONFIG_INVALID`，**不会静默回退 Mock**
- 真实密钥不要提交到 Git；`.env.example` 只保留空值模板

### 真实模型的职责边界

- 只用于信息理解（提取任务、拆解子任务），不决定任何具体时间
- 不直接操作数据库，不自动确认提取 / 拆解 / 重排
- 结果仍要经过与 Mock 完全相同的 Zod 契约校验与 evidence 校验

### Prompt 模板

- [prompts.ts](src/lib/ai/prompts.ts) 集中管理提取与拆解 Prompt
- `EXTRACTION_PROMPT_VERSION = "1.0"`、`DECOMPOSITION_PROMPT_VERSION = "1.0"`
- DecisionLog 只记录版本号，不记录完整 Prompt（模板本身在 Git 仓库中）

### 真实模型的 evidence 策略

模型只返回 `quote`，服务端在原文中定位并计算 `start/end`，不信任模型自报的字符偏移：

```
模型输出 quote → 原文唯一命中 → 计算 start/end → 正式 Evidence → 复用 S2 校验
              ├─ 0 次命中 → EVIDENCE_NOT_FOUND
              └─ 多次命中 → EVIDENCE_AMBIGUOUS
```

### 错误与重试

- `AI_CONFIG_INVALID` / `AI_REQUEST_FAILED` / `AI_TIMEOUT` / `AI_RESPONSE_INVALID` / `AI_SCHEMA_INVALID` / `EVIDENCE_NOT_FOUND` / `EVIDENCE_AMBIGUOUS`
- 网络错误与 HTTP 5xx 最多自动重试 1 次；400 / 401 / 403 / schema / evidence 错误不重试
- 请求使用 `AbortController` 超时（默认 30s），不会无限挂起

### S6 验证

```bash
npm run s6:verify   # 离线验证（fetch 打桩，不访问互联网、不消耗 API）
npm run s6:smoke    # 可选真实冒烟（未配置 real 时直接 SKIPPED）
```

## S5 当前能力

### CalendarEvent 与 Course 的区别

- `Course`：按周重复的固定课程（dayOfWeek + startMinute/endMinute），作为排期硬约束
- `CalendarEvent`（S5 新增）：一次性固定占用（startAt/endAt），例如"周四 19:00-20:30 学院讲座"
- 两者都不可被排期引擎移动，但 CalendarEvent 只发生一次

### 冲突检测

- 纯函数 `detectConflicts()`：输入有效 Schedule + Course + CalendarEvent，复用 S4 的 `[start,end)` 半开区间重叠规则（`a.start < b.end && b.start < a.end`）
- 支持 Schedule vs Course、Schedule vs CalendarEvent 两类冲突；边界相接（19:00 与 19:00）不算冲突
- `runConflictDetection()`：按 `(scheduleAId, 固定占用)` 应用层去重，同一未解决组合不会重复写入
- `CANCELLED` 状态的 Schedule 不参与检测（与 S4 effective = `status != CANCELLED` 一致）
- 冲突描述来自真实时间数据，例如："「完成方案初稿」原计划 19:00-21:00，与临时事件「学院讲座」19:30-20:30 重叠 60 分钟。"

### detect → preview → human confirm → replan

1. 用户在 `/schedule` 点击「添加临时事件」，填写标题/日期/起止时间/地点，提交后服务端校验 `startAt < endAt`，创建 `CalendarEvent` 并立即运行冲突检测
2. 页面显示"发现 N 个计划冲突"，被影响的正式 Schedule 以红色高亮
3. 点击「重新规划」→ `POST /api/schedule/replan-preview`：服务端计算受影响 owner 集合，**只对这些 owner 重新排期**，其余 Schedule 作为固定占用保留
4. 页面展示原计划 → 建议新计划对比，每个新块附带真实约束生成的 rationale
5. 用户确认 → `POST /api/schedule/replan-confirm`：服务端重新查询并逐条复核 12 类约束，单事务写入

### 受影响 owner 与下游依赖

- 直接冲突 owner ∪ 其下游依赖 owner 的传递闭包（B 依赖 A，A 被移动则 B 也进入受影响集合）
- 未受影响 Schedule 仍作为固定占用；受影响 owner 的旧 Schedule 在 preview 排期时从占用中移除，但数据库中保留

### 重排如何复用 PlanningEngine

- `generateReplanPreview()` 复用 S4 的 `planSchedule()` 纯函数，不重写时间算法
- 输入：受影响 owner 的 PlanningItem[]、课程、busy（未受影响 Schedule + CalendarEvent）、dependencyReadyAt（未受影响已排 owner 的完成时间）
- 输出的新块在原 rationale 前追加冲突原因（直接冲突："原计划与固定占用发生冲突…"；下游联动："由于前置任务完成时间延后…"）
- 找不到合法时段时返回 unresolved，不强行安排

### 为什么旧 Schedule 不删除

- 确认重排时，被替代的旧 Schedule `status` 改为 `CANCELLED`（不 delete），新 Schedule 以 `CONFIRMED` 创建
- 这样旧计划仍保留在数据库历史里，但不再属于有效占用（与 S4 effective 语义一致）
- 不新增 `MOVED` 状态，避免破坏现有有效 Schedule 语义

### Conflict 如何保留 before/after

- `Conflict.resolution` 保存可读的前后变化摘要（哪些块从何时段移至何时段）
- `Conflict.resolvedAt` 标记解决时间；为空表示未解决
- 重排确认时创建 `DecisionLog(actionType=REPLAN)`，记录冲突摘要、旧/新 Schedule 摘要、受影响 owner 数量与约束

### 事务与重复确认保护

- `replan-confirm` 单事务内：二次校验冲突仍未解决 → 旧 Schedule 仍有效 → 旧 Schedule 改 CANCELLED → 创建新 Schedule → 更新 Conflict.resolution/resolvedAt → 写 DecisionLog
- 任一步失败整体回滚，不会出现"旧计划取消了但新计划没创建"的半状态
- 重复确认同一冲突会被以 `CONFLICT_ALREADY_RESOLVED` 拒绝

## S3 当前能力

- `/tasks` 左侧任务列表（截止 / 优先级 / 状态 / 来源）、右侧任务详情（描述、来源与原文依据、子任务）
- 「AI 拆解任务」生成拆解预览：子任务标题、预计耗时、顺序与依赖关系
- 确认前可编辑：子任务标题、预计耗时、依赖关系（可调整或取消）
- 「确认拆解」后事务写入 SubTask + SubTaskDependency + DecisionLog（DECOMPOSE）
- 已拆解任务展示正式子任务，不支持重复拆解或覆盖（服务端 409）
- 演示数据内置一个尚未拆解的任务（《数据结构》课程设计报告），便于直接演示

### 拆解流程

```
Task → AI decompose → DecompositionResult（Zod 校验 + 依赖 DAG 校验）
     → 用户人工编辑 → 服务端再次校验 → Prisma transaction 入库 → DecisionLog 留痕
```

### 子任务依赖约束

- `dependsOn` 只能引用同一次拆解结果内的 `clientId`（禁止用数据库 ID 直接提交）
- 禁止自依赖、禁止引用不存在的节点、禁止成环（复用 S1 的 `findDependencyCycle`）
- 子任务数量 2~8，预计耗时 15~480 分钟，`sortOrder` 唯一
- **最终判断在服务端执行**，前端提示只是辅助

AI 仅提出建议，人工确认后才进入正式数据；`MockAIProvider` 仍只是开发期 Provider。

## S2 当前能力

- 粘贴校园通知 → AI 结构化提取（事件 / 任务 / 截止 / 优先级 / 预计耗时 / 原文依据）
- 原文证据高亮：点击任务卡的「查看原文依据」在原文中精确高亮对应字符范围
- 人工确认前可编辑任务字段（标题 / 截止 / 优先级 / 耗时 / 描述）
- 确认入库：事务写入 Source + Task + DecisionLog，服务端复核 evidence
- 重复提交防护：按钮禁用 + 相同原文服务端拒绝（409）
- `/inbox` 页提供「加载演示通知」一键载入虚构演示样本

## 验证命令

```bash
npm run db:verify   # S1 数据层关联验证
npm run s2:verify   # S2 提取链路验证（Mock/契约/确定性/入库与清理）
npm run s3:verify   # S3 拆解链路验证（契约/DAG/事务写入与回滚/清理）
npm run s4:verify   # S4 排期验证（构建规则/确定性引擎/约束/确认事务/清理）
npm run s5:verify   # S5 冲突检测与重排验证（CalendarEvent/检测/受影响集合/预览/确认事务/清理）
npm run s6:verify   # S6 真实 Provider 验证（配置/请求组装/超时重试/错误码/quote 定位，离线）
npm run s7:verify   # S7 决策解释时间线验证（聚合/角色映射/old→new/容错/契约/清理，隔离库）
```

## AIProvider 架构

- `src/lib/ai/contract.ts`：Zod 契约 + evidence 精确校验（唯一校验入口）
- `src/lib/ai/provider.ts`：AIProvider 接口（含 provider / model / prompt 版本元信息）
- `src/lib/ai/mock-provider.ts`：**开发期 Mock**（确定性规则解析，模拟 500~1000ms 延迟；保守原则，识别不了就不提取）
- `src/lib/ai/real-provider.ts`：**真实 Provider**（原生 fetch 调 OpenAI-compatible 接口，不引入厂商 SDK）
- `src/lib/ai/config.ts`：环境变量读取与启动校验（`AI_CONFIG_INVALID`）
- `src/lib/ai/prompts.ts`：提取 / 拆解 Prompt 模板与版本号
- `src/lib/ai/index.ts`：`getAIProvider()` 工厂，经环境变量 `AI_PROVIDER=mock|real` 切换，不缓存、不回退

## 环境要求

- Node.js >= 20.9（推荐 22+ LTS，本项目在 v24.22.0 验证）
- npm >= 10（本项目在 11.19.1 验证）
- Git >= 2.40（本项目在 2.56.0 验证）

## 快速开始

```bash
# 安装依赖（postinstall 会自动生成 Prisma Client）
npm install

# 创建/应用数据库迁移（开发环境）
npm run db:migrate

# 写入演示种子数据（幂等，可重复运行）
npm run db:seed

# 验证数据层关联
npm run db:verify

# 启动开发服务器（http://localhost:3000）
npm run dev

# 生产构建
npm run build
```

## 数据库（S1）

- ORM：Prisma 7（`prisma-client` 生成器 + `@prisma/adapter-better-sqlite3` 驱动适配器）
- 数据库：SQLite，本地文件 `prisma/dev.db`（已被 .gitignore 忽略，不入库）
- 配置：`prisma.config.ts`（schema 路径 / 迁移 / seed 命令 / 连接 URL）
- 迁移文件：`prisma/migrations/`（纳入版本管理，新环境可直接重建）

新环境从零重建数据库：

```bash
npm install          # 依赖 + 自动生成 Prisma Client
npm run db:migrate   # 应用迁移，创建表结构
npm run db:seed      # 写入幂等演示数据
npm run db:verify    # 校验关联数据
```

## 技术栈

- Next.js（App Router）+ TypeScript
- Tailwind CSS
- ESLint
- Prisma 7 + SQLite
- npm 包管理器
