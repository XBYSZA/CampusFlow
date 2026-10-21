-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "location" TEXT,
    "eventType" TEXT NOT NULL DEFAULT 'OTHER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Conflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleAId" TEXT NOT NULL,
    "scheduleBId" TEXT,
    "courseId" TEXT,
    "calendarEventId" TEXT,
    "conflictType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "resolution" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Conflict_scheduleAId_fkey" FOREIGN KEY ("scheduleAId") REFERENCES "Schedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Conflict_scheduleBId_fkey" FOREIGN KEY ("scheduleBId") REFERENCES "Schedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Conflict_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Conflict_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "CalendarEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Conflict" ("conflictType", "courseId", "createdAt", "description", "id", "resolution", "resolvedAt", "scheduleAId", "scheduleBId") SELECT "conflictType", "courseId", "createdAt", "description", "id", "resolution", "resolvedAt", "scheduleAId", "scheduleBId" FROM "Conflict";
DROP TABLE "Conflict";
ALTER TABLE "new_Conflict" RENAME TO "Conflict";
CREATE INDEX "Conflict_scheduleAId_idx" ON "Conflict"("scheduleAId");
CREATE INDEX "Conflict_scheduleBId_idx" ON "Conflict"("scheduleBId");
CREATE INDEX "Conflict_courseId_idx" ON "Conflict"("courseId");
CREATE INDEX "Conflict_calendarEventId_idx" ON "Conflict"("calendarEventId");
CREATE INDEX "Conflict_conflictType_idx" ON "Conflict"("conflictType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CalendarEvent_startAt_idx" ON "CalendarEvent"("startAt");
