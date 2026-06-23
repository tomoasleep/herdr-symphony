import { SqliteCompletedRepository } from "./completed-repository"
import { openDatabase } from "./database"
import { SqliteLogRepository } from "./log-repository"
import { SqliteStateRepository } from "./state-repository"
import type { Storage, StorageConfig } from "./types"

export function createStorage(config: StorageConfig): Storage {
  const db = openDatabase(config.databasePath)

  return {
    completed: new SqliteCompletedRepository(db),
    logs: new SqliteLogRepository(db),
    state: new SqliteStateRepository(db),
    close: () => db.close(),
  }
}

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  databasePath: ".workaholic/db.sqlite3",
  completedRetention: 1000,
  logRetention: 5000,
}
