# CampusFlow

把校园信息变成可解释的行动计划 —— 面向大学生的校园事务智能规划与执行助手。

## 当前阶段

S3 · 任务板 + AI 任务拆解

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
