# CampusFlow

把碎片化校园信息转化为**可解释、可执行、可调整**的行动计划。

## 1. 项目简介

CampusFlow 面向校园通知、比赛、课程与活动场景。它解决的问题是：**通知很多，但真正困难的是知道要做什么、什么时候做，以及计划变化后怎么办。**

产品闭环：

```
通知 / 非结构化文本
        ↓ AI 信息理解
任务提取 + Evidence（原文依据）
        ↓ Human Confirm
AI 任务拆解（子任务 + 依赖）
        ↓ Human Confirm
Rule Engine 排期（确定性约束求解）
        ↓ Human Confirm
CalendarEvent / Conflict 冲突检测
        ↓
Deterministic Replan（确定性重排）
        ↓ Human Confirm
Task Complete（完成闭环）
        ↓
DecisionTimeline 全程可解释
```

核心原则：**AI 不负责排期。** 所有时间决策由确定性规则引擎完成。

## 2. AI × Rule Engine × Human

| 角色 | 职责 |
| --- | --- |
| **AI** | 非结构化信息理解、Task Extraction、Task Decomposition |
| **Rule Engine** | 时间槽计算、Course / CalendarEvent 约束、Dependency、Deadline、Conflict Detection、Replanning |
| **Human** | Confirm Extraction、Confirm Decomposition、Confirm Plan、Confirm Replan、Complete Task |

**为什么这样分工**：LLM 适合语义理解，但时间区间、冲突、依赖、deadline 属于确定性约束。CampusFlow 采用「LLM for semantics，Deterministic engine for constraints」——收益是结果可重复、可验证、可解释，不会因为模型随机性产生重叠日程。

**DecisionTimeline**：全局决策解释抽屉聚合真实系统中的 DecisionLog / Evidence / Schedule / Conflict 记录进行展示，**不调用 LLM 重新编造解释**。AI 调用上下文（provider / model / promptVersion / durationMs）仅作展示与调试，不是审计证据。

## 3. 技术栈

以 `package.json` 实际依赖为准：

- **Next.js 16.4.2**（App Router / Turbopack）+ **React 19.3.0** + **TypeScript ^5**
- **Tailwind CSS ^4** + ESLint
- **Prisma 7.10.1** + **SQLite**（better-sqlite3 13）
- **Zod ^4**（全链路契约校验）
- **Native fetch**（RealAIProvider，OpenAI-compatible HTTP，可接 DeepSeek 等端点，不引入厂商 SDK / LangChain）
- npm 包管理器

环境要求：Node.js ≥ 20.9（推荐 22+ LTS，在 v24.22.0 验证）、npm ≥ 10（在 11.19.1 验证）、Git ≥ 2.40。

## 4. Quick Start

面向第一次拿到仓库的评委。**默认 Mock 模式即可完整复现主要产品链路，无需任何 API Key。**

```bash
# 1. Clone
git clone https://github.com/XBYSZA/CampusFlow.git
cd CampusFlow

# 2. Install（postinstall 会自动生成 Prisma Client）
npm install

# 3. Environment：复制 .env.example 为 .env
#    Windows PowerShell:
copy .env.example .env
#    macOS / Linux:
#    cp .env.example .env
#    默认 AI_PROVIDER=mock，不需要填写任何 Key

# 4. Prepare demo database（重建迁移 + 演示基线，可重复执行）
npm run db:demo

# 5. Start
npm run dev

# 6. Browser
#    http://localhost:3000
```

从 clone 到页面可操作，全程不依赖 DeepSeek 等外部 API。

## 5. Optional: Real LLM

真实模型**不是**运行项目的必要条件，仅用于展示真实模型的 extraction / decomposition。在 `.env` 中配置：

```bash
AI_PROVIDER=real
REAL_LLM_BASE_URL=https://<your-endpoint>/v1
REAL_LLM_API_KEY=<your-key>
REAL_LLM_MODEL=<your-model>
REAL_LLM_TIMEOUT_MS=30000   # 可选，默认 30000
```

- 当前实现为 OpenAI-compatible HTTP API（原生 fetch + AbortController 超时；网络/5xx 最多重试 1 次，4xx/schema/evidence 错误不重试）
- **Real provider 只负责 extraction 与 decomposition**；Planning / Replanning 不受 provider 切换影响，仍由确定性引擎完成
- `AI_PROVIDER=real` 但配置缺失时返回 `AI_CONFIG_INVALID`，**不会静默回退 Mock**
- 只读取服务端环境变量（无 `NEXT_PUBLIC_` 前缀），Key 不进入浏览器；`.env` 不提交 Git，`.env.example` 仅含空值模板

## 6. Demo Notice（固定演示通知）

点击 Inbox 页「**加载演示通知**」按钮即可载入固定演示文本（[demo-notice.ts](src/lib/fixtures/demo-notice.ts)，Mock 规则可稳定提取 3 项任务），无需手动复制。全文：

```text
【校学生科技创新协会】关于举办 2026 年校园数字创意挑战赛的通知

各位同学：

为鼓励数字创意实践，校学生科技创新协会定于 2026 年 11 月举办校园数字创意挑战赛，现将有关事项通知如下。

一、参赛对象：全校在读本科生，可个人或组队参赛，每队不超过 3 人。
二、报名材料提交截止时间为 2026 年 10 月 28 日 18:00，请将报名表发送至赛事公邮。
三、项目方案（含作品演示视频）提交截止时间为 2026 年 11 月 5 日 12:00，逾期视为放弃参赛资格。
四、决赛路演答辩定于 2026 年 11 月 15 日 14:00 在创新楼报告厅举行，每队展示 8 分钟。
五、奖项设置：一等奖 1 名、二等奖 2 名、三等奖 3 名，获奖团队颁发证书与奖金。

请有意参赛的同学合理安排时间，按时提交各项材料。

校学生科技创新协会
2026 年 10 月 21 日
```

## 7. Recommended Demo Flow（9 步）

1. **Inbox** → 加载 Demo Notice
2. **AI 解析** → 提取出 3 项任务
3. 点击 **Evidence** → 原文中精确高亮 quote 依据
4. **Confirm Tasks** → 人工确认入库（Source + Task + DecisionLog）
5. **Tasks** → AI Decompose → 编辑/确认子任务与依赖 → Confirm
6. **Schedule** → Generate 预览（虚线块 + rationale）→ Confirm 写入
7. 添加临时 **CalendarEvent** → 页面红色高亮 **Conflict**
8. **Replan** → 预览 old → new → Confirm；打开 **DecisionDrawer** 查看完整决策链
9. **Complete** → 子任务逐个完成 → 父任务自动完成，未来计划取消，时间线出现 COMPLETE / HUMAN

Mock 模式可完整走通主流程；Real 模式用于展示真实模型的 extraction / decomposition。

## 8. Decision Explainability（DecisionDrawer）

Inbox / Tasks / Schedule 三页共用的全局决策解释抽屉，阶段 → 角色映射：

| 阶段 | 角色 |
| --- | --- |
| EXTRACT | AI |
| DECOMPOSE | AI |
| PLAN | RULE_ENGINE |
| REPLAN | RULE_ENGINE |
| COMPLETE | HUMAN |

- Evidence、rationale、old → new 对照**全部来自已有系统记录**（DecisionLog / Schedule / Conflict），不重新生成
- REPLAN 展示：触发冲突 → 固定占用方 → 原计划（CANCELLED，保留历史）→ 新计划（CONFIRMED）
- `aiContext`（provider / model / promptVersion / durationMs）仅为「**AI 调用上下文**」，用于展示与调试，**不是不可篡改的审计证据**
- 阶段缺失自动跳过：未拆解或未重排的任务，对应阶段不显示、接口不报错

## 9. Prompt Pipeline

Prompt 模板集中管理于 [prompts.ts](src/lib/ai/prompts.ts)，当前版本（与源码一致）：

- `EXTRACTION_PROMPT_VERSION = "1.0"`
- `DECOMPOSITION_PROMPT_VERSION = "1.1"`（明确 15~480 分钟、15 分钟粒度、2~8 子任务）

DecisionLog 只记录版本号，不记录完整 Prompt（模板在 Git 仓库中，可复现）。

**Real model 输出不会被直接信任**：

```
模型 JSON
  → candidate schema（宽松候选层）
  → deterministic normalization（estimatedMinutes 按 15 分钟粒度向上取整并 clamp 到 15~480）
  → formal Zod schema（正式契约）
  → evidence / dependency validation（quote 原文定位；DAG 环检测）
  → human confirmation（人工确认后才写入正式数据）
```

Evidence 策略：模型只返回 `quote`，由服务端在原文中定位 `start/end`——0 次命中报 `EVIDENCE_NOT_FOUND`，多次命中报 `EVIDENCE_AMBIGUOUS`，不信任模型自报的字符偏移。

## 10. Scheduling Semantics

与源码（`src/lib/planning`、`src/lib/time.ts`）一致：

- 时区 **Asia/Shanghai**（UTC+8，无夏令时），不引入大型日期库
- 可安排区间 **08:00-22:00**，最小排期粒度 **30 分钟**
- 区间语义 **[start, end)**：10:00-11:00 与 11:00-12:00 边界相接不算冲突
- **Course = 硬约束**（按周重复），**CalendarEvent = 硬约束**（一次性固定占用）
- **effective Schedule**（`status != CANCELLED`）= busy 占用
- **DONE** owner 不再参与 planning / replanning
- **CANCELLED** schedule 保留历史但不再占用、不参与冲突检测
- 长任务拆块：单块 30~120 分钟；estimatedMinutes 非 30 整数倍按 `ceil(est/30)*30` 排期并在 rationale 说明
- 依赖：后续子任务不得早于全部前置完成时间
- 排期 / 重排均为「预览 → 人工确认 → 服务端全量复核 → 单事务写入」，任何失败整体回滚

## 11. Verification

以下命令均真实存在于 `package.json`：

```bash
npm run db:demo      # 重置演示数据库（仅允许本地 prisma/dev.db，否则 DEMO_RESET_UNSAFE_DATABASE）
npm run demo:verify  # 演示基线验证（两轮重置一致/空状态/结构，隔离临时库）
npm run db:verify    # S1 数据层关联验证（隔离临时库）
npm run s2:verify    # S2 提取链路验证（Mock/契约/确定性/入库清理）
npm run s3:verify    # S3 拆解链路验证（契约/DAG/事务/清理）
npm run s4:verify    # S4 排期验证（确定性引擎/约束/确认事务，隔离库）
npm run s5:verify    # S5 冲突检测与重排验证（CalendarEvent/重排事务/清理）
npm run s6:verify    # S6 真实 Provider 验证（配置/重试/错误码/quote 定位，离线打桩）
npm run s6:smoke     # 可选真实冒烟（未配置 real 时直接 SKIPPED）
npm run s7:verify    # S7 决策解释时间线 + 完成闭环验证（隔离库）
npm run build        # 生产构建
npm run lint         # ESLint
```

verify 脚本尽可能使用临时 / 隔离数据库（`prisma/dev.db.<tag>`，结束后自动清理），避免污染真实演示 `dev.db`。

## 12. Evolution History

9 条线性 commit（`git log --oneline` 可查）：

| 阶段 | Commit | 内容 |
| --- | --- | --- |
| S0 | `2eb2cc1` | 项目骨架（Next.js + TS + Tailwind 脚手架） |
| S1 | `5ee80cf` | Prisma 数据模型与可复现 seed |
| S2 | `18a1774` | Explainable Inbox Extraction（提取 + Evidence） |
| S3 | `b7e985f` | Task Decomposition（拆解 + 依赖 DAG） |
| S4 | `7df9abe` | Deterministic Planning（确定性排期） |
| S5 | `e542e67` | Conflict-aware Replanning（冲突 + 重排） |
| S6 | `f1c1f7d` | Real LLM Provider + Prompt Pipeline |
| S7 | `4ce1c94` | Decision Timeline + Completion Lifecycle |
| S9 | `1977298` | Reproducible Demo Reset（一键演示重置） |

注：编号跳过 S8——S8 是远程备份 / 交付步骤（首次 push 到 GitHub），不产生代码变更，因此没有对应 commit，也未伪造。

## 13. Project Structure

```
src/
  app/          # 页面（/ /inbox /tasks /schedule）与 API 路由
  components/   # 共用 AppShell、全局 DecisionDrawer 等 UI 组件
  lib/
    ai/         # AIProvider 接口、Mock/Real Provider、Prompt 模板、Zod 契约
    planning/   # 确定性 PlanningEngine（纯函数）与排期契约
    services/   # inbox / tasks / schedule / decision / completion 业务服务
    decision/   # DecisionTimeline 展示契约
    fixtures/   # 固定演示通知
prisma/         # schema、migrations、seed、本地 dev.db（不入库）
scripts/        # 各阶段 verify、demo 重置与基线验证（隔离临时库）
```

## 14. Security & Data Safety

- `.env` 不提交 Git（`.gitignore` 覆盖），`.env.example` 仅含空值模板
- API Key 仅服务端读取（无 `NEXT_PUBLIC_` 前缀），不返回浏览器、不写入 DecisionLog
- 无 silent Real→Mock fallback：real 模式配置缺失即报 `AI_CONFIG_INVALID`
- demo reset 仅允许项目本地 `prisma/dev.db`，其他路径一律 `DEMO_RESET_UNSAFE_DATABASE` 拒绝执行；不使用模糊 `*.db` 删除
- verify 脚本使用隔离临时库并自动清理，不会对演示库做全表删除

## 15. Known Boundaries（MVP Scope）

当前为比赛 MVP，边界如实说明：

- 单用户本地演示场景，无登录 / 权限系统
- SQLite 本地文件库，非多用户并发设计
- `aiContext` 是 AI 调用上下文，不是不可篡改的审计记录
- Real Provider 当前聚焦 extraction / decomposition，不参与排期与重排
