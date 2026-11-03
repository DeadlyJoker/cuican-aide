import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type LocalProjectDocument = Readonly<{
  documentId: string;
  revision: number;
  digest: string;
  content: string;
}>;

const MAX_BYTES = 256 * 1024;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Opt-in storage for an already authorized project root. It grants no workspace access. */
export class LocalProjectDocuments {
  readonly #root: string;
  constructor(projectRoot: string) {
    this.#root = resolve(projectRoot);
    if (
      realpathSync(this.#root) !== this.#root ||
      !lstatSync(this.#root).isDirectory()
    )
      throw new Error("project_document_root_invalid");
  }

  #directory(documentId: string, create: boolean): string | null {
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(documentId))
      throw new Error("project_document_id_invalid");
    if (realpathSync(this.#root) !== this.#root)
      throw new Error("project_document_root_changed");
    let path = this.#root;
    for (const part of ["documents", documentId]) {
      path = join(path, part);
      if (create) {
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === "ENOENT")
          return null;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("project_document_directory_invalid");
    }
    return path;
  }

  read(documentId: string): LocalProjectDocument | null {
    const directory = this.#directory(documentId, false);
    if (directory === null) return null;
    const revisions = readdirSync(directory)
      .filter((name) => /^[0-9]{10}\.md$/.test(name))
      .sort();
    const latest = revisions.at(-1);
    if (latest === undefined) return null;
    const path = join(directory, latest);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
      throw new Error("project_document_file_invalid");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const content = readFileSync(fd, "utf8");
      if (Buffer.byteLength(content) > MAX_BYTES)
        throw new Error("project_document_too_large");
      return Object.freeze({
        documentId,
        revision: Number(latest.slice(0, 10)),
        digest: digest(content),
        content,
      });
    } finally {
      closeSync(fd);
    }
  }

  save(
    input: Readonly<{
      documentId: string;
      expectedRevision: number;
      content: string;
    }>,
  ): LocalProjectDocument {
    const { documentId, expectedRevision, content } = input;
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= 9999999999
    )
      throw new Error("project_document_revision_invalid");
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES)
      throw new Error("project_document_too_large");
    const directory = this.#directory(documentId, true)!;
    const lock = join(directory, ".write-lock");
    let lockFd;
    try {
      lockFd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("project_document_busy");
      throw error;
    }
    const temporary = join(directory, `.pending-${randomUUID()}`);
    try {
      const current = this.read(documentId);
      if (
        current?.content === content &&
        (current.revision === expectedRevision ||
          current.revision === expectedRevision + 1)
      )
        return current;
      if ((current?.revision ?? 0) !== expectedRevision)
        throw new Error("project_document_revision_conflict");
      const revision = expectedRevision + 1;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, content, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Publish without replacing an existing revision; pending files are never read.
      linkSync(
        temporary,
        join(directory, `${String(revision).padStart(10, "0")}.md`),
      );
      return Object.freeze({
        documentId,
        revision,
        digest: digest(content),
        content,
      });
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        closeSync(lockFd);
        unlinkSync(lock);
      }
    }
  }
}
