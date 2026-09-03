import path from 'node:path';
import React, {useEffect, useState} from 'react';
import {Box, render, Text, useApp} from 'ink';
import {Alert, ConfirmInput, ProgressBar, Select, Spinner, StatusMessage, TextInput} from '@inkjs/ui';
import {checkBundleVolume, getBundleStatus, prepareBundle, requiredBundleBytes, writeBundleReport, type BundleProgress, type BundleVolumeInfo} from './bundle.js';
import {analyzeBundle, repairBundle, type RepairAnalysis} from './bundle-repair.js';
import {inventoryTakeout} from './takeout.js';
import {checkForUpdate, installUpdate, type AvailableUpdate} from './updates.js';
import {VERSION, PACKAGE_NAME} from './version.js';
import {listSelectableExternalVolumes, type ExternalVolume} from './volume.js';
import type {BundleManifest, TakeoutInventory} from './domain.js';

type Screen =
  | 'checking-update' | 'update-available' | 'updating' | 'update-complete'
  | 'menu' | 'tools'
  | 'source' | 'select-volume' | 'no-external-volume' | 'confirm' | 'preparing' | 'complete'
  | 'tools-inspect-source' | 'tools-inspect-volume' | 'tools-inspect-result'
  | 'tools-status-volume' | 'tools-status-result'
  | 'tools-report-volume' | 'tools-report-result'
  | 'tools-repair-volume' | 'tools-repair-path' | 'tools-repair-analysis' | 'tools-repair-confirm' | 'tools-repair-progress' | 'tools-repair-result';

interface InspectResult {
  source: string;
  inventory: TakeoutInventory;
  requiredBytes: number;
  volumeInfo?: BundleVolumeInfo;
  volumeError?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = -1;
  do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(1)} ${units[index]}`;
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function plannedRepairActions(analysis: RepairAnalysis): string {
  const backfills = analysis.findings.filter(finding => finding.action === 'backfill-final-hash').length;
  const metadata = analysis.findings.filter(finding => finding.action === 'reapply-metadata').length;
  return `Planned mutations: ${backfills} finalHash backfills · ${metadata} metadata reapplications`;
}

export function prepareFailureAction(message: string): string {
  if (message.includes('Bundle was prepared for a different source')) {
    return 'Use the original Takeout source to resume, or start fresh on a new empty destination by clearing both import/ and .gfotos-migrator/, then try again.';
  }
  if (message.includes('Bundle state is corrupt') || message.includes('Corrupt bundle manifest')) {
    return 'Start fresh on a new empty destination, or manually clear both import/ and .gfotos-migrator/ before running prepare again.';
  }
  return 'Resolve the reported source, destination, or storage issue, then try again.';
}

function Banner(): React.JSX.Element {
  return <Box borderStyle="round" borderColor="cyan" paddingX={1}>
    <Text bold color="cyan">{PACKAGE_NAME} {VERSION}</Text>
  </Box>;
}

function App(): React.JSX.Element {
  const {exit} = useApp();
  const [screen, setScreen] = useState<Screen>('checking-update');
  const [sourcePath, setSourcePath] = useState('');
  const [volumePath, setVolumePath] = useState('');
  const [externalVolumes, setExternalVolumes] = useState<ExternalVolume[]>([]);
  const [inventory, setInventory] = useState<TakeoutInventory>();
  const [error, setError] = useState<string>();
  const [errorAction, setErrorAction] = useState<string>();
  const [progress, setProgress] = useState<BundleProgress>();
  const [manifest, setManifest] = useState<BundleManifest>();
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate>();

  // Tools > Inspect Takeout
  const [inspectSourcePath, setInspectSourcePath] = useState('');
  const [inspectInventory, setInspectInventory] = useState<TakeoutInventory>();
  const [inspectResult, setInspectResult] = useState<InspectResult>();

  // Tools > Status / Report
  const [statusManifest, setStatusManifest] = useState<BundleManifest>();
  const [reportPath, setReportPath] = useState<string>();
  const [repairAnalysis, setRepairAnalysis] = useState<RepairAnalysis>();
  const [repairProgress, setRepairProgress] = useState({completed: 0, total: 0});

  const checkUpdates = async (): Promise<void> => {
    try {
      const update = await checkForUpdate(VERSION);
      if (update) {
        setAvailableUpdate(update);
        setScreen('update-available');
        return;
      }
    } catch {
      // A release lookup failure must not block bundle preparation.
    }
    setScreen('menu');
  };

  const applyUpdate = async (): Promise<void> => {
    if (!availableUpdate) return;
    try {
      setError(undefined);
      setScreen('updating');
      await installUpdate(availableUpdate);
      setScreen('update-complete');
    } catch (failure) {
      setError(failureMessage(failure));
      setScreen('update-available');
    }
  };

  useEffect(() => { void checkUpdates(); }, []);

  const loadExternalVolumes = async (): Promise<void> => {
    try {
      setError(undefined);
      setErrorAction(undefined);
      const volumes = await listSelectableExternalVolumes();
      setExternalVolumes(volumes);
      setScreen(volumes.length > 0 ? 'select-volume' : 'no-external-volume');
    } catch (failure) {
      setError(failureMessage(failure));
      setErrorAction('Connect an external volume and try again, or return to the menu.');
    }
  };

  const inspectGuidedSource = async (value: string): Promise<void> => {
    try {
      setError(undefined);
      setErrorAction(undefined);
      const trimmed = value.trim();
      const result = await inventoryTakeout(trimmed);
      if (result.inventory.archives === 0) throw new Error('No ZIP archives were found in the selected path.');
      if (result.media.length === 0) throw new Error('No supported photos or videos were found in the ZIP archives.');
      setSourcePath(path.resolve(trimmed));
      setInventory(result.inventory);
      await loadExternalVolumes();
    } catch (failure) {
      setError(failureMessage(failure));
      setErrorAction('Check the source path and confirm it contains Google Takeout ZIP archives, then try again.');
    }
  };

  const selectVolume = async (volume: ExternalVolume): Promise<void> => {
    if (!inventory) return;
    try {
      setError(undefined);
      setErrorAction(undefined);
      await checkBundleVolume(volume.mountPoint, requiredBundleBytes(inventory));
      setVolumePath(volume.mountPoint);
      setScreen('confirm');
    } catch (failure) {
      setError(failureMessage(failure));
      setErrorAction('Select a different destination volume with enough free, writable space.');
    }
  };

  const startPreparation = async (): Promise<void> => {
    try {
      setError(undefined);
      setErrorAction(undefined);
      setScreen('preparing');
      const result = await prepareBundle(volumePath, sourcePath, setProgress);
      setProgress(result);
      const currentManifest = await getBundleStatus(volumePath);
      setManifest(currentManifest);
      setScreen('complete');
    } catch (failure) {
      const message = failureMessage(failure);
      setError(message);
      setErrorAction(prepareFailureAction(message));
      setScreen('select-volume');
    }
  };

  // Tools > Inspect Takeout
  const runToolsInspectSource = async (value: string): Promise<void> => {
    try {
      setError(undefined);
      setErrorAction(undefined);
      const trimmed = value.trim();
      const {inventory: sourceInventory} = await inventoryTakeout(trimmed);
      setInspectSourcePath(path.resolve(trimmed));
      setInspectInventory(sourceInventory);
      setScreen('tools-inspect-volume');
    } catch (failure) {
      setError(failureMessage(failure));
      setErrorAction('Check the source path and confirm it contains Google Takeout ZIP archives, then try again.');
    }
  };

  const runToolsInspectVolume = async (value: string): Promise<void> => {
    if (!inspectInventory) return;
    const trimmed = value.trim();
    const required = requiredBundleBytes(inspectInventory);
    let volumeInfo: BundleVolumeInfo | undefined;
    let volumeError: string | undefined;
    if (trimmed) {
      try {
        volumeInfo = await checkBundleVolume(trimmed, required);
      } catch (failure) {
        volumeError = failureMessage(failure);
      }
    }
    setInspectResult({source: inspectSourcePath, inventory: inspectInventory, requiredBytes: required, volumeInfo, volumeError});
    setScreen('tools-inspect-result');
  };

  // Tools > Status
  const runToolsStatus = async (value: string): Promise<void> => {
    try {
      setError(undefined);
      setErrorAction(undefined);
      const result = await getBundleStatus(path.resolve(value.trim()));
      setStatusManifest(result);
      setScreen('tools-status-result');
    } catch (failure) {
      setError(failureMessage(failure));
      setErrorAction('Run prepare on this volume first, or confirm the path points to a prepared Import Bundle volume.');
    }
  };

  // Tools > Report
  const runToolsReport = async (value: string): Promise<void> => {
    try {
      setError(undefined);
      setErrorAction(undefined);
      const destination = await writeBundleReport(path.resolve(value.trim()));
      setReportPath(destination);
      setScreen('tools-report-result');
    } catch (failure) {
      setError(failureMessage(failure));
      setErrorAction('Run prepare on this volume first, or confirm the path points to a prepared Import Bundle volume.');
    }
  };

  const runRepairAnalysis = async (value: string): Promise<void> => {
    try {
      setError(undefined); setErrorAction(undefined);
      const result = await analyzeBundle(path.resolve(value.trim()));
      setRepairAnalysis(result); setScreen('tools-repair-analysis');
    } catch (failure) {
      setError(failureMessage(failure));
      setErrorAction('Connect the bundle volume, or provide the path to an existing Import Bundle. No bundle files were changed except the analysis report when preflight succeeded.');
    }
  };

  const startRepair = async (): Promise<void> => {
    if (!repairAnalysis) return;
    try {
      setError(undefined); setErrorAction(undefined); setRepairProgress({completed: 0, total: repairAnalysis.summary.repairable}); setScreen('tools-repair-progress');
      const result = await repairBundle(repairAnalysis, (completed, total) => setRepairProgress({completed, total}));
      setRepairAnalysis(result); setScreen('tools-repair-result');
    } catch (failure) {
      setError(failureMessage(failure));
      setErrorAction('The journal preserves completed work. Re-run analysis and repair after resolving the reported destination or permission issue.');
      setScreen('tools-repair-analysis');
    }
  };

  return <Box flexDirection="column" padding={1} gap={1}>
    <Banner/>
    {error && <Alert variant="error">{error}</Alert>}
    {errorAction && <Text color="yellow">{errorAction}</Text>}
    {screen === 'checking-update' && <Spinner label="Checking for updates..."/>}
    {screen === 'update-available' && availableUpdate && <><StatusMessage variant="info">{`Version ${availableUpdate.version} is available.`}</StatusMessage><Text>{`Update from ${VERSION} now?`}</Text><ConfirmInput defaultChoice="cancel" onConfirm={() => void applyUpdate()} onCancel={() => setScreen('menu')}/></>}
    {screen === 'updating' && <Spinner label="Downloading and installing the update..."/>}
    {screen === 'update-complete' && <><StatusMessage variant="success">Update installed successfully.</StatusMessage><Text>Restart gfotos-migrator to use the new version.</Text><ConfirmInput defaultChoice="confirm" onConfirm={exit} onCancel={exit}/></>}

    {screen === 'menu' && <>
      <Text>Prepares a Google Takeout Import Bundle on a destination volume of your choice.</Text>
      <Text dimColor>No Photos automation, iCloud change, or disk formatting is performed.</Text>
      <Select options={[
        {label: 'Start guided migration', value: 'start'},
        {label: 'Tools', value: 'tools'},
        {label: 'Exit', value: 'exit'}
      ]} onChange={value => {
        setError(undefined);
        setErrorAction(undefined);
        if (value === 'start') setScreen('source');
        else if (value === 'tools') setScreen('tools');
        else exit();
      }}/>
    </>}

    {screen === 'tools' && <>
      <Text bold>Tools</Text>
      <Select options={[
        {label: 'Inspect Takeout', value: 'inspect'},
        {label: 'Prepare or resume Import Bundle', value: 'prepare'},
        {label: 'Status', value: 'status'},
        {label: 'Report', value: 'report'},
        {label: 'Analyze and repair existing Import Bundle', value: 'repair'},
        {label: 'Back', value: 'back'}
      ]} onChange={value => {
        setError(undefined);
        setErrorAction(undefined);
        if (value === 'inspect') setScreen('tools-inspect-source');
        else if (value === 'prepare') setScreen('source');
        else if (value === 'status') setScreen('tools-status-volume');
        else if (value === 'report') setScreen('tools-report-volume');
        else if (value === 'repair') void loadExternalVolumes().then(() => setScreen('tools-repair-volume'));
        else setScreen('menu');
      }}/>
    </>}

    {screen === 'source' && <>
      <Text>Enter the folder containing Google Takeout ZIP archives:</Text>
      <TextInput placeholder="/Volumes/External/Takeout" onSubmit={value => void inspectGuidedSource(value)}/>
    </>}

    {screen === 'select-volume' && inventory && <>
      <Text bold>Select the destination volume for the Import Bundle.</Text>
      <Text dimColor>{`Required free space: ${formatBytes(requiredBundleBytes(inventory))}. System volumes, Time Machine destinations, and read-only volumes are excluded. Any writable filesystem is accepted.`}</Text>
      <Select visibleOptionCount={10} options={[
        ...externalVolumes.map(volume => ({label: `${volume.name} — ${volume.filesystem || 'unknown'} — ${formatBytes(volume.availableBytes)} free of ${formatBytes(volume.capacityBytes)}`, value: volume.mountPoint})),
        {label: 'Cancel migration', value: 'cancel'}
      ]} onChange={value => {
        if (value === 'cancel') setScreen('menu');
        else {
          const volume = externalVolumes.find(candidate => candidate.mountPoint === value);
          if (volume) void selectVolume(volume);
        }
      }}/>
    </>}

    {screen === 'no-external-volume' && <>
      <StatusMessage variant="warning">No selectable external storage was found.</StatusMessage>
      <Text>Connect a writable external volume with enough free space and try again.</Text>
      <Select options={[
        {label: 'Retry', value: 'retry'},
        {label: 'Cancel migration', value: 'cancel'}
      ]} onChange={value => {
        if (value === 'retry') void loadExternalVolumes();
        else setScreen('menu');
      }}/>
    </>}

    {screen === 'confirm' && inventory && <>
      <StatusMessage variant="info">No Photos automation or iCloud change will be performed.</StatusMessage>
      <Text>{`Prepare an Import Bundle for ${inventory.images} photos and ${inventory.videos} videos on:`}</Text>
      <Text color="yellow">{volumePath}</Text>
      <ConfirmInput defaultChoice="cancel" onConfirm={() => void startPreparation()} onCancel={() => setScreen('select-volume')}/>
    </>}

    {screen === 'preparing' && <>
      <Spinner label="Preparing the Import Bundle..."/>
      <ProgressBar value={progress ? (progress.completed / Math.max(progress.total, 1)) * 100 : 0}/>
      <Text>{progress ? `${progress.completed}/${progress.total} processed · ${progress.materialized} materialized · ${progress.duplicate} duplicate · ${progress.failed} failed` : 'Starting...'}</Text>
      {progress?.current && <Text dimColor>{progress.current}</Text>}
    </>}

    {screen === 'complete' && progress && <>
      <StatusMessage variant="success">Import Bundle prepared.</StatusMessage>
      <Text>{`Source: ${sourcePath}`}</Text>
      <Text>{`Import path: ${path.join(volumePath, 'import')}`}</Text>
      <Text>{`Materialized: ${progress.materialized} · Duplicate: ${progress.duplicate} · Failed: ${progress.failed} · Skipped: ${progress.skipped}`}</Text>
      {manifest && <Text>{`Missing sidecar metadata: ${manifest.counts.missingSidecar}`}</Text>}
      <Text bold color="yellow">{`Next step: open Photos and manually import the files in ${path.join(volumePath, 'import')}. This tool does not automate Photos import.`}</Text>
      <Select options={[{label: 'Back to menu', value: 'menu'}]} onChange={() => setScreen('menu')}/>
    </>}

    {screen === 'tools-inspect-source' && <>
      <Text>Enter the folder containing Google Takeout ZIP archives:</Text>
      <TextInput placeholder="/Volumes/External/Takeout" onSubmit={value => void runToolsInspectSource(value)}/>
    </>}

    {screen === 'tools-inspect-volume' && <>
      <Text>Enter a destination volume to validate capacity, or press Enter to skip:</Text>
      <TextInput placeholder="(optional) /Volumes/External" onSubmit={value => void runToolsInspectVolume(value)}/>
    </>}

    {screen === 'tools-inspect-result' && inspectResult && <>
      <StatusMessage variant="info">Takeout inspection result</StatusMessage>
      <Text>{`Source: ${inspectResult.source}`}</Text>
      <Text>{`Archives: ${inspectResult.inventory.archives} · Photos: ${inspectResult.inventory.images} · Videos: ${inspectResult.inventory.videos}`}</Text>
      <Text>{`Required free space: ${formatBytes(inspectResult.requiredBytes)}`}</Text>
      {inspectResult.volumeInfo && <Text color="green">{`Destination is writable with ${formatBytes(inspectResult.volumeInfo.availableBytes)} available.`}</Text>}
      {inspectResult.volumeError && <Text color="red">{inspectResult.volumeError}</Text>}
      <Select options={[{label: 'Back to Tools', value: 'tools'}, {label: 'Back to menu', value: 'menu'}]} onChange={value => setScreen(value === 'tools' ? 'tools' : 'menu')}/>
    </>}

    {screen === 'tools-status-volume' && <>
      <Text>Enter the destination volume to inspect:</Text>
      <TextInput placeholder="/Volumes/External" onSubmit={value => void runToolsStatus(value)}/>
    </>}

    {screen === 'tools-status-result' && statusManifest && <>
      <StatusMessage variant="info">Import Bundle status</StatusMessage>
      <Text>{`Created: ${statusManifest.createdAt} · Updated: ${statusManifest.updatedAt}`}</Text>
      <Text>{`Total: ${statusManifest.counts.total} · Materialized: ${statusManifest.counts.materialized} · Duplicate: ${statusManifest.counts.duplicate}`}</Text>
      <Text>{`Failed: ${statusManifest.counts.failed} · Skipped: ${statusManifest.counts.skipped} · Pending: ${statusManifest.counts.pending}`}</Text>
      <Text>{`Missing sidecar metadata: ${statusManifest.counts.missingSidecar}`}</Text>
      <Select options={[{label: 'Back to Tools', value: 'tools'}, {label: 'Back to menu', value: 'menu'}]} onChange={value => setScreen(value === 'tools' ? 'tools' : 'menu')}/>
    </>}

    {screen === 'tools-report-volume' && <>
      <Text>Enter the destination volume to write a report for:</Text>
      <TextInput placeholder="/Volumes/External" onSubmit={value => void runToolsReport(value)}/>
    </>}

    {screen === 'tools-report-result' && reportPath && <>
      <StatusMessage variant="success">Report written.</StatusMessage>
      <Text>{reportPath}</Text>
      <Select options={[{label: 'Back to Tools', value: 'tools'}, {label: 'Back to menu', value: 'menu'}]} onChange={value => setScreen(value === 'tools' ? 'tools' : 'menu')}/>
    </>}

    {screen === 'tools-repair-volume' && <>
      <Text bold>Select an existing Import Bundle volume, or choose an explicit path.</Text>
      <Select visibleOptionCount={10} options={[
        ...externalVolumes.map(volume => ({label: `${volume.name} — ${volume.mountPoint}`, value: volume.mountPoint})),
        {label: 'Enter bundle volume path', value: 'explicit'},
        {label: 'Back to Tools', value: 'back'}
      ]} onChange={value => {
        if (value === 'explicit') setScreen('tools-repair-path');
        else if (value === 'back') setScreen('tools');
        else void runRepairAnalysis(value);
      }}/>
    </>}

    {screen === 'tools-repair-path' && <>
      <Text>Enter the volume path containing import/ and .gfotos-migrator/:</Text>
      <TextInput placeholder="/Volumes/External" onSubmit={value => void runRepairAnalysis(value)}/>
    </>}

    {screen === 'tools-repair-analysis' && repairAnalysis && <>
      <StatusMessage variant="info">Analysis complete (read-only except for the report).</StatusMessage>
      <Text>{`Validated: ${repairAnalysis.summary.validated} · Repairable: ${repairAnalysis.summary.repairable} · Unchanged: ${repairAnalysis.summary.unchanged}`}</Text>
      <Text>{`Unchecked: ${repairAnalysis.summary.unchecked} · Invalid: ${repairAnalysis.summary.invalid} · Missing: ${repairAnalysis.summary.missing}`}</Text>
      <Text>{`Orphaned: ${repairAnalysis.summary.orphaned} · Source required: ${repairAnalysis.summary.sourceRequired} · Failed: ${repairAnalysis.summary.failed}`}</Text>
      <Text>{plannedRepairActions(repairAnalysis)}</Text>
      <Text dimColor>{`Analysis report: ${repairAnalysis.reportPath}`}</Text>
      {repairAnalysis.summary.repairable > 0
        ? <><Text>Repair will only backfill verified hashes or reapply stored metadata through a validated temporary sibling. No media files are deleted or renamed.</Text><ConfirmInput defaultChoice="cancel" onConfirm={() => void startRepair()} onCancel={() => setScreen('tools')}/></>
        : <><Text color="yellow">No safe repair action is available. Items requiring original source data remain unchanged.</Text><Select options={[{label: 'Back to Tools', value: 'tools'}]} onChange={() => setScreen('tools')}/></>}
    </>}

    {screen === 'tools-repair-progress' && repairAnalysis && <>
      <Spinner label="Repairing the Import Bundle..."/>
      <ProgressBar value={repairProgress.total ? (repairProgress.completed / repairProgress.total) * 100 : 100}/>
      <Text>{`${repairProgress.completed}/${repairProgress.total} repair actions checkpointed`}</Text>
    </>}

    {screen === 'tools-repair-result' && repairAnalysis && <>
      <StatusMessage variant="success">Repair complete.</StatusMessage>
      <Text>{`Validated: ${repairAnalysis.summary.validated} · Repaired: ${repairProgress.completed} · Repairable remaining: ${repairAnalysis.summary.repairable}`}</Text>
      <Text>{`Validated import path: ${repairAnalysis.paths.importPath}`}</Text>
      <Text dimColor>{`Final analysis report: ${repairAnalysis.reportPath}`}</Text>
      <Select options={[{label: 'Back to Tools', value: 'tools'}]} onChange={() => setScreen('tools')}/>
    </>}
  </Box>;
}

export async function runTui(): Promise<void> {
  const instance = render(<App/>);
  await instance.waitUntilExit();
}
