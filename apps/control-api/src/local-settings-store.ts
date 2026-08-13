import { DatabaseSync } from "node:sqlite";

export type LocalSettings = Readonly<{
  locale: "en" | "zh";
  theme: "dark" | "light";
  revision: number;
  updatedAt: string | null;
}>;

export class LocalSettingsRevisionConflictError extends Error {
  readonly code = "local_settings_revision_conflict";

  constructor() {
    super("local_settings_revision_conflict");
    this.name = "LocalSettingsRevisionConflictError";
  }
}

/** Device-local settings authority. It is intentionally not composed in Team mode. */
export class LocalSettingsStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`CREATE TABLE IF NOT EXISTS local_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      locale TEXT NOT NULL CHECK (locale IN ('en', 'zh')),
      theme TEXT NOT NULL CHECK (theme IN ('dark', 'light')),
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`);
  }

  get(): LocalSettings {
    const row = this.#database
      .prepare(
        "SELECT locale, theme, revision, updated_at FROM local_settings WHERE singleton = 1",
      )
      .get() as
      | {
          locale: "en" | "zh";
          theme: "dark" | "light";
          revision: number;
          updated_at: string;
        }
      | undefined;
    return row === undefined
      ? { locale: "zh", theme: "light", revision: 0, updatedAt: null }
      : {
          locale: row.locale,
          theme: row.theme,
          revision: row.revision,
          updatedAt: row.updated_at,
        };
  }

  put(input: {
    locale: "en" | "zh";
    theme: "dark" | "light";
    expectedRevision: number;
  }): LocalSettings {
    const updatedAt = new Date().toISOString();
    const result = this.#database
      .prepare(
        `INSERT INTO local_settings(singleton, locale, theme, revision, updated_at)
         SELECT 1, ?, ?, 1, ?
         WHERE ? = 0 OR EXISTS (SELECT 1 FROM local_settings WHERE singleton = 1)
         ON CONFLICT(singleton) DO UPDATE SET
           locale=excluded.locale,
           theme=excluded.theme,
           revision=local_settings.revision + 1,
           updated_at=excluded.updated_at
         WHERE local_settings.revision = ?`,
      )
      .run(
        input.locale,
        input.theme,
        updatedAt,
        input.expectedRevision,
        input.expectedRevision,
      );
    if (result.changes !== 1) throw new LocalSettingsRevisionConflictError();
    return this.get();
  }

  close(): void {
    this.#database.close();
  }
}
