import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { BrowserError } from "./errors.ts";

export class ArtifactStore {
  constructor(readonly root: string) {}

  name(prefix: string, extension: string): string {
    return `browser-artifacts/${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  }

  async output(input: string): Promise<string> {
    const root = await fs.realpath(this.root);
    const lexicalRoot = path.resolve(this.root);
    const lexicalRelative = path.relative(lexicalRoot, input);
    const mappedInput = path.isAbsolute(input) && lexicalRelative && !lexicalRelative.startsWith(`..${path.sep}`) && lexicalRelative !== ".." && !path.isAbsolute(lexicalRelative) ? lexicalRelative : input;
    const destination = path.resolve(root, mappedInput);
    const relative = path.relative(root, destination);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new BrowserError("invalid_path", "Artifact paths must be inside the active workspace.");
    }
    const parts = relative.split(path.sep);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      let stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (!stat && index < parts.length - 1) {
        await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        stat = await fs.lstat(current);
      }
      if (stat?.isSymbolicLink() || (index < parts.length - 1 && !stat?.isDirectory())) {
        throw new BrowserError("invalid_path", "Artifact paths cannot traverse symlinks or non-directories.");
      }
    }
    return destination;
  }

  async write(input: string, data: string | Uint8Array): Promise<string> {
    const destination = await this.output(input);
    const file = await fs.open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
    return destination;
  }

  async copy(input: string, source: string): Promise<string> {
    const destination = await this.output(input);
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    await fs.chmod(destination, 0o600);
    return destination;
  }

  async read(input: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
    const destination = await this.output(input);
    const file = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new BrowserError("invalid_artifact", "Artifact is not a regular file or exceeds the read limit.");
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
}

export async function writeJsonAtomic(destination: string, data: unknown): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
