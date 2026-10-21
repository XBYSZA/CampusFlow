# CampusFlow

把校园信息变成可解释的行动计划 —— 面向大学生的校园事务智能规划与执行助手。

## 当前阶段

S2 · 智能收件箱（Mock AI 提取）

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
