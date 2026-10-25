import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ARTIFACT_STORAGE = Symbol('ARTIFACT_STORAGE');
export interface ArtifactStorage {
  put(key: string, content: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalArtifactStorage implements ArtifactStorage {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  private path(key: string): string {
    if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-z_]+-[a-f0-9]{64}\.(json|ndjson|js|html)$/.test(key)) {
      throw new Error('invalid_artifact_key');
    }
    return join(this.root, key);
  }

  async put(key: string, content: Buffer, contentType?: string): Promise<void> {
    if (contentType && !['application/json', 'application/x-ndjson', 'application/javascript', 'text/html'].includes(contentType)) {
      throw new Error('unsupported_artifact_type');
    }
    if (content.length > 67108864) throw new Error('artifact_file_too_large');
    const path = this.path(key);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    if (!(await realpath(dirname(path))).startsWith(`${root}${sep}`)) throw new Error('invalid_artifact_path');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async get(key: string): Promise<Buffer> {
    const path = this.path(key);
    const root = await realpath(this.root);
    if (!(await realpath(path)).startsWith(`${root}${sep}`)) throw new Error('invalid_artifact_path');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size > 67108864) throw new Error('artifact_file_too_large');
      return await file.readFile();
    } finally { await file.close(); }
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    try {
      const root = await realpath(this.root);
      if (!(await realpath(dirname(path))).startsWith(`${root}${sep}`)) throw new Error('invalid_artifact_path');
      await rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function createArtifactStorage(config: ConfigService): ArtifactStorage {
  const provider = config.get<string>('ARTIFACT_STORAGE') ?? 'local';
  if (provider !== 'local') throw new ServiceUnavailableException({ code: 'storage_not_configured',
    message: 'Cloud storage integration is pending. Use ARTIFACT_STORAGE=local for local testing.' });
  if (config.get<string>('AUTH_MODE') !== 'local-mock' || !['development', 'test'].includes(config.get<string>('NODE_ENV') ?? '')) {
    throw new ServiceUnavailableException('Local artifact storage is available only in explicit local mock mode');
  }
  return new LocalArtifactStorage(config.get<string>('ARTIFACTS_DIR') ?? '.local/artifacts');
}

export async function readResultFile(directory: string, filename: string, maximum: number): Promise<Buffer> {
  const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('result_file_too_large');
    return await file.readFile();
  } finally { await file.close(); }
}
