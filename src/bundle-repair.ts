import {copyFile, lstat, readdir, readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {BundleDatabase} from './bundle-database.js';
import {loadManifest, saveManifest} from './bundle.js';
import {sha256File} from './takeout.js';
import {applyTakeoutMetadata} from './media.js';
import {validateMediaFile} from './media-validate.js';
import {VERSION} from './version.js';
import type {BundleItem, BundleManifest, BundlePaths, MetadataFieldStatuses} from './domain.js';

export type RepairCategory = 'validated' | 'repairable' | 'repaired' | 'unchanged' | 'unchecked' | 'invalid' | 'missing' | 'orphaned' | 'source-required' | 'failed';
export type RepairAction = 'backfill-final-hash' | 'reapply-metadata' | 'none' | 'source-required';

export interface RepairFinding {
  identity: string;
  category: RepairCategory;
  action: RepairAction;
  reason?: string;
}

export interface RepairSummary {
  validated: number;
  repairable: number;
  repaired: number;
  unchanged: number;
  unchecked: number;
  invalid: number;
  missing: number;
  orphaned: number;
  sourceRequired: number;
  failed: number;
}

export interface RepairAnalysis {
  paths: BundlePaths;
  manifest: BundleManifest;
  findings: RepairFinding[];
  summary: RepairSummary;
  reportPath: string;
}

interface RepairJournal {
  version: 1;
  toolVersion: string;
  bundleVersion: number;
  startedAt: string;
  completedAt?: string;
  completed: string[];
}

function existingPaths(volumePath: string): BundlePaths {
  const volume = path.resolve(volumePath);
  const bundlePath = path.join(volume, '.gfotos-migrator');
  return {volumePath: volume, importPath: path.join(volume, 'import'), bundlePath,
    databasePath: path.join(bundlePath, 'bundle.sqlite'), sidecarsPath: path.join(bundlePath, 'sidecars'),
    reportsPath: path.join(bundlePath, 'reports'), manifestPath: path.join(bundlePath, 'manifest.json')};
}

function safeOutputPath(importPath: string, finalPath: string | undefined): string | undefined {
  if (!finalPath || path.isAbsolute(finalPath)) return undefined;
  const output = path.resolve(importPath, finalPath);
  const relative = path.relative(importPath, output);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? output : undefined;
}

function emptySummary(): RepairSummary {
  return {validated: 0, repairable: 0, repaired: 0, unchanged: 0, unchecked: 0, invalid: 0, missing: 0, orphaned: 0, sourceRequired: 0, failed: 0};
}

function add(summary: RepairSummary, category: RepairCategory): void {
  if (category === 'source-required') summary.sourceRequired++;
  else summary[category]++;
}

function identity(item: BundleItem): string { return item.hash.slice(0, 12); }

async function listImportFiles(root: string): Promise<{files: Set<string>; unsafe: string[]}> {
  const files = new Set<string>();
  const unsafe: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { unsafe.push(full); continue; }
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.add(full);
    }
  }
  await walk(root);
  return {files, unsafe};
}

function reportText(analysis: Omit<RepairAnalysis, 'reportPath'>): string {
  const lines = ['# Import Bundle Analysis', '', `Generated: ${new Date().toISOString()}`, `Bundle version: ${analysis.manifest.version}`, '', '## Summary', '', '| Outcome | Count |', '| --- | ---: |'];
  for (const [key, value] of Object.entries(analysis.summary)) lines.push(`| ${key} | ${value} |`);
  lines.push('', '## Findings', '', '| Identity | Outcome | Planned action | Reason |', '| --- | --- | --- | --- |');
  for (const finding of analysis.findings) lines.push(`| ${finding.identity} | ${finding.category} | ${finding.action} | ${(finding.reason ?? '').replaceAll('|', '\\|')} |`);
  lines.push('');
  return lines.join('\n');
}

export async function analyzeBundle(volumePath: string): Promise<RepairAnalysis> {
  const paths = existingPaths(volumePath);
  const manifest = await loadManifest(paths);
  if (!manifest) throw new Error('No Import Bundle found: manifest.json is missing.');
  if (manifest.version > 1) throw new Error(`Bundle version ${manifest.version} is newer than this tool supports. Upgrade gfotos-migrator before analyzing it.`);
  const database = await BundleDatabase.open(paths.databasePath, {readOnly: true});
  const findings: RepairFinding[] = [];
  const summary = emptySummary();
  try {
    const items = database.listItems();
    const referenced = new Set<string>();
    for (const item of items) {
      const output = safeOutputPath(paths.importPath, item.finalPath);
      if (!output) {
        const finding = {identity: identity(item), category: 'invalid' as const, action: 'source-required' as const, reason: 'The stored output path is unsafe.'};
        findings.push(finding); add(summary, finding.category); continue;
      }
      referenced.add(output);
      let fileInfo;
      try { fileInfo = await lstat(output); } catch { fileInfo = undefined; }
      if (!fileInfo || !fileInfo.isFile() || fileInfo.isSymbolicLink()) {
        const finding = {identity: identity(item), category: 'missing' as const, action: 'source-required' as const, reason: 'The referenced output is missing from the bundle.'};
        findings.push(finding); add(summary, finding.category); continue;
      }
      const validation = await validateMediaFile(output, item.mediaKind);
      if (validation.status === 'invalid') {
        const finding = {identity: identity(item), category: 'invalid' as const, action: 'source-required' as const, reason: 'The referenced output failed content validation.'};
        findings.push(finding); add(summary, finding.category); continue;
      }
      if (validation.status === 'unchecked') {
        const finding = {identity: identity(item), category: 'unchecked' as const, action: 'none' as const, reason: 'This format is not currently content-validated.'};
        findings.push(finding); add(summary, finding.category); continue;
      }
      const currentHash = await sha256File(output);
      if (item.finalHash === currentHash) {
        const finding = {identity: identity(item), category: 'validated' as const, action: 'none' as const};
        findings.push(finding); add(summary, finding.category); continue;
      }
      const metadata = database.getItemMetadata(item.hash);
      const hasMetadataToApply = metadata && Object.values(metadata.fieldStatuses).some(status => status === 'present');
      const finding = hasMetadataToApply
        ? {identity: identity(item), category: 'repairable' as const, action: 'reapply-metadata' as const, reason: 'Stored normalized metadata can be reapplied transactionally.'}
        : item.finalHash
          ? {identity: identity(item), category: 'failed' as const, action: 'none' as const, reason: 'The current output hash differs from the persisted final hash.'}
          : {identity: identity(item), category: 'repairable' as const, action: 'backfill-final-hash' as const, reason: 'Valid legacy output is missing finalHash.'};
      findings.push(finding); add(summary, finding.category);
    }
    const importFiles = await listImportFiles(paths.importPath);
    for (const file of importFiles.files) {
      if (!referenced.has(file)) { const finding = {identity: 'unreferenced', category: 'orphaned' as const, action: 'none' as const, reason: 'File is not referenced by bundle.sqlite.'}; findings.push(finding); add(summary, finding.category); }
    }
    for (const file of importFiles.unsafe) { const finding = {identity: 'unsafe-entry', category: 'invalid' as const, action: 'none' as const, reason: 'Symlink under import/ was not followed.'}; findings.push(finding); add(summary, finding.category); }
  } finally { database.close(); }
  await mkdir(paths.reportsPath, {recursive: true, mode: 0o700});
  const reportPath = path.join(paths.reportsPath, `repair-analysis-${new Date().toISOString().replaceAll(':', '-')}.md`);
  await writeFile(reportPath, reportText({paths, manifest, findings, summary}), {mode: 0o600});
  return {paths, manifest, findings, summary, reportPath};
}

async function loadJournal(paths: BundlePaths, manifest: BundleManifest): Promise<RepairJournal> {
  const journalPath = path.join(paths.bundlePath, 'repair-run.json');
  try { return JSON.parse(await readFile(journalPath, 'utf8')) as RepairJournal; }
  catch { return {version: 1, toolVersion: VERSION, bundleVersion: manifest.version, startedAt: new Date().toISOString(), completed: []}; }
}

export async function repairBundle(analysis: RepairAnalysis, onProgress?: (completed: number, total: number) => void): Promise<RepairAnalysis> {
  if (analysis.manifest.version > 1) throw new Error('This bundle is newer than the running tool and cannot be mutated.');
  const paths = analysis.paths;
  const journalPath = path.join(paths.bundlePath, 'repair-run.json');
  const journal = await loadJournal(paths, analysis.manifest);
  await mkdir(path.join(paths.bundlePath, 'repair-backups'), {recursive: true, mode: 0o700});
  if (journal.completed.length === 0) {
    const stamp = new Date().toISOString().replaceAll(':', '-');
    await copyFile(paths.databasePath, path.join(paths.bundlePath, 'repair-backups', `bundle-${stamp}.sqlite`));
    await copyFile(paths.manifestPath, path.join(paths.bundlePath, 'repair-backups', `manifest-${stamp}.json`));
    await writeFile(journalPath, JSON.stringify(journal, null, 2), {mode: 0o600});
  }
  const database = await BundleDatabase.open(paths.databasePath);
  try {
    const actionable = analysis.findings.filter(f => f.action !== 'none' && f.category === 'repairable');
    let completed = 0;
    for (const finding of actionable) {
      if (journal.completed.includes(finding.identity)) { completed++; continue; }
      const item = database.listItems().find(candidate => identity(candidate) === finding.identity);
      if (!item) continue;
      const output = safeOutputPath(paths.importPath, item.finalPath);
      if (!output) continue;
      const metadata = database.getItemMetadata(item.hash);
      if (finding.action === 'reapply-metadata' && metadata) {
        const statuses = await applyTakeoutMetadata(output, item.mediaKind, metadata.metadata);
        database.updateItemMetadataStatuses(item.hash, {...metadata.fieldStatuses, ...statuses} as MetadataFieldStatuses);
      }
      const finalHash = await sha256File(output);
      database.save({...item, finalHash});
      journal.completed.push(finding.identity);
      completed++;
      await writeFile(journalPath, JSON.stringify(journal, null, 2), {mode: 0o600});
      onProgress?.(completed, actionable.length);
    }
    const counts = database.countByState();
    const nextManifest = {...analysis.manifest, updatedAt: new Date().toISOString(), counts: {...analysis.manifest.counts, ...counts}, metadataCounts: database.countMetadata()};
    await saveManifest(paths, nextManifest);
    journal.completedAt = new Date().toISOString();
    await writeFile(journalPath, JSON.stringify(journal, null, 2), {mode: 0o600});
  } finally { database.close(); }
  return analyzeBundle(paths.volumePath);
}
