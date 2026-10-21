-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'NOTICE',
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "deadline" DATETIME,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "estimatedMinutes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'TODO',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "estimatedMinutes" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'TODO',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubTaskDependency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subTaskId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubTaskDependency_subTaskId_fkey" FOREIGN KEY ("subTaskId") REFERENCES "SubTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SubTaskDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "SubTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "location" TEXT
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "subTaskId" TEXT,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "rationale" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Schedule_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Schedule_subTaskId_fkey" FOREIGN KEY ("subTaskId") REFERENCES "SubTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleAId" TEXT NOT NULL,
    "scheduleBId" TEXT,
    "courseId" TEXT,
    "conflictType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "resolution" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Conflict_scheduleAId_fkey" FOREIGN KEY ("scheduleAId") REFERENCES "Schedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Conflict_scheduleBId_fkey" FOREIGN KEY ("scheduleBId") REFERENCES "Schedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Conflict_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DecisionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionType" TEXT NOT NULL,
    "inputSummary" TEXT NOT NULL,
    "outputSummary" TEXT NOT NULL,
    "evidence" TEXT,
    "relatedTaskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionLog_relatedTaskId_fkey" FOREIGN KEY ("relatedTaskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Source_sourceType_idx" ON "Source"("sourceType");

-- CreateIndex
CREATE INDEX "Task_sourceId_idx" ON "Task"("sourceId");

-- CreateIndex
CREATE INDEX "Task_deadline_idx" ON "Task"("deadline");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "SubTask_taskId_idx" ON "SubTask"("taskId");

-- CreateIndex
CREATE INDEX "SubTask_status_idx" ON "SubTask"("status");

-- CreateIndex
CREATE INDEX "SubTaskDependency_dependsOnId_idx" ON "SubTaskDependency"("dependsOnId");

-- CreateIndex
CREATE UNIQUE INDEX "SubTaskDependency_subTaskId_dependsOnId_key" ON "SubTaskDependency"("subTaskId", "dependsOnId");

-- CreateIndex
CREATE INDEX "Course_dayOfWeek_idx" ON "Course"("dayOfWeek");

-- CreateIndex
CREATE INDEX "Schedule_taskId_idx" ON "Schedule"("taskId");

-- CreateIndex
CREATE INDEX "Schedule_subTaskId_idx" ON "Schedule"("subTaskId");

-- CreateIndex
CREATE INDEX "Schedule_startAt_idx" ON "Schedule"("startAt");

-- CreateIndex
CREATE INDEX "Conflict_scheduleAId_idx" ON "Conflict"("scheduleAId");

-- CreateIndex
CREATE INDEX "Conflict_scheduleBId_idx" ON "Conflict"("scheduleBId");

-- CreateIndex
CREATE INDEX "Conflict_courseId_idx" ON "Conflict"("courseId");

-- CreateIndex
CREATE INDEX "Conflict_conflictType_idx" ON "Conflict"("conflictType");

-- CreateIndex
CREATE INDEX "DecisionLog_actionType_idx" ON "DecisionLog"("actionType");

-- CreateIndex
CREATE INDEX "DecisionLog_relatedTaskId_idx" ON "DecisionLog"("relatedTaskId");
