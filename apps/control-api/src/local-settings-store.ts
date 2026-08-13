import { DatabaseSync } from "node:sqlite";

export type LocalSettings = Readonly<{
  locale: "en" | "zh";
  theme: "dark" | "light";
  revision: number;
  updatedAt: string | null;
}>;

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
    const current = this.get();
    if (current.revision !== input.expectedRevision)
      throw new Error("local_settings_revision_conflict");
    const updatedAt = new Date().toISOString();
    const revision = current.revision + 1;
    this.#database
      .prepare(
        `INSERT INTO local_settings(singleton, locale, theme, revision, updated_at)
      VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
      locale=excluded.locale, theme=excluded.theme, revision=excluded.revision, updated_at=excluded.updated_at`,
      )
      .run(input.locale, input.theme, revision, updatedAt);
    return { locale: input.locale, theme: input.theme, revision, updatedAt };
  }

  close(): void {
    this.#database.close();
  }
}
