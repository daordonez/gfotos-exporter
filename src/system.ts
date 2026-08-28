import {spawn} from 'node:child_process';
import {access, mkdir, rm, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import type {CommandResult} from './domain.js';

export async function run(command: string, args: string[], options: {cwd?: string; input?: string} = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: options.cwd, stdio: 'pipe'});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) {
        resolve({stdout, stderr});
        return;
      }
      reject(new Error(`${command} failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(target: string): Promise<void> {
  await mkdir(target, {recursive: true, mode: 0o700});
}

export async function ensureEmptyDirectory(target: string): Promise<void> {
  await rm(target, {recursive: true, force: true});
  await ensureDirectory(target);
}

export function isSafeArchivePath(entryPath: string): boolean {
  const normalized = path.posix.normalize(entryPath);
  return !path.posix.isAbsolute(normalized) && !normalized.startsWith('../') && normalized !== '..';
}

export async function fileSize(target: string): Promise<number> {
  return (await stat(target)).size;
}
