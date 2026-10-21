# CampusFlow

把校园信息变成可解释的行动计划 —— 面向大学生的校园事务智能规划与执行助手。

## 当前阶段

S1 · 数据层（Prisma 7 + SQLite）

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
