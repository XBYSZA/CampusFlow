# CampusFlow

把校园信息变成可解释的行动计划 —— 面向大学生的校园事务智能规划与执行助手。

## 当前阶段

S4 · 课表 + 基础智能排期

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
```

## AIProvider 架构

- `src/lib/ai/contract.ts`：Zod 契约 + evidence 精确校验（唯一校验入口）
- `src/lib/ai/provider.ts`：AIProvider 接口
- `src/lib/ai/mock-provider.ts`：**开发期 Mock**（确定性规则解析，模拟 500~1000ms 延迟；保守原则，识别不了就不提取）
- `src/lib/ai/index.ts`：`getAIProvider()` 工厂，经环境变量 `AI_PROVIDER=mock|real` 切换
- 未来接入真实大模型：新增 `RealAIProvider` 实现同一接口并在工厂注册即可，Inbox 页面与数据库逻辑零改动

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
