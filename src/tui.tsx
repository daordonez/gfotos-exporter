import path from 'node:path';
import React, {useEffect, useState} from 'react';
import {Box, render, Text, useApp} from 'ink';
import {Alert, ConfirmInput, ProgressBar, Select, Spinner, StatusMessage, TextInput} from '@inkjs/ui';
import {requiredBytes} from './migration.js';
import {inventoryTakeout} from './takeout.js';
import {checkForUpdate, installUpdate, type AvailableUpdate} from './updates.js';
import {VERSION, PACKAGE_NAME} from './version.js';
import {listSelectableExternalVolumes, type ExternalVolume} from './volume.js';
import {prepareBundle, getBundleStatus, writeBundleReport, type BundleProgress} from './bundle.js';
import type {BundleManifest, TakeoutInventory} from './domain.js';

type Screen = 'checking-update' | 'update-available' | 'updating' | 'update-complete'
  | 'menu' | 'tools'
  | 'source' | 'select-volume' | 'no-external-volume' | 'preparing' | 'complete'
  | 'tools-inspect-source' | 'tools-inspect-result'
  | 'tools-prepare-source' | 'tools-prepare-volume' | 'tools-prepare-running' | 'tools-prepare-result'
  | 'tools-status-volume' | 'tools-status-result'
  | 'tools-report-volume' | 'tools-report-result';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = -1;
  do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(1)} ${units[index]}`;
}

function Banner(): React.JSX.Element {
  return <Box borderStyle="round" borderColor="cyan" paddingX={1}>
    <Text bold color="cyan">{PACKAGE_NAME} {VERSION}</Text>
  </Box>;
}

function App(): React.JSX.Element {
  useApp();
  const [screen, setScreen] = useState<Screen>('checking-update');
  const [sourcePath, setSourcePath] = useState('');
  const [volumePath, setVolumePath] = useState('');
  const [externalVolumes, setExternalVolumes] = useState<ExternalVolume[]>([]);
  const [inventory, setInventory] = useState<TakeoutInventory>();
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<BundleProgress>();
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate>();

  const [toolsSource, setToolsSource] = useState('');
  const [toolsVolume, setToolsVolume] = useState('');
  const [toolsInventory, setToolsInventory] = useState<TakeoutInventory>();
  const [toolsManifest, setToolsManifest] = useState<BundleManifest>();
  const [toolsReportPath, setToolsReportPath] = useState<string>();

  const checkUpdates = async (): Promise<void> => {
    try {
      const update = await checkForUpdate(VERSION);
      if (update) {
        setAvailableUpdate(update);
        setScreen('update-available');
        return;
      }
    } catch {
      // A release lookup failure must not block a local migration.
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
      setError(failure instanceof Error ? failure.message : String(failure));
      setScreen('update-available');
    }
  };

  useEffect(() => { void checkUpdates(); }, []);

  const inspectSource = async (value: string): Promise<void> => {
    try {
      setError(undefined);
      const {inventory: result} = await inventoryTakeout(value.trim());
      if (result.archives === 0) throw new Error('No ZIP archives were found in the selected path.');
      if (result.images === 0 && result.videos === 0) throw new Error('No supported photos or videos were found in the ZIP archives.');
      setSourcePath(path.resolve(value.trim()));
      setInventory(result);
      await loadExternalVolumes();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };

  const loadExternalVolumes = async (): Promise<void> => {
    try {
      setError(undefined);
      const volumes = await listSelectableExternalVolumes();
      setExternalVolumes(volumes);
      setScreen(volumes.length > 0 ? 'select-volume' : 'no-external-volume');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };

  const runPrepare = async (destination: string): Promise<void> => {
    if (!inventory || !sourcePath) return;
    try {
      setError(undefined);
      setVolumePath(destination);
      setScreen('preparing');
      const result = await prepareBundle(destination, sourcePath, setProgress);
      setProgress(result);
      setScreen('complete');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setScreen('select-volume');
    }
  };

  const selectVolume = async (volume: ExternalVolume): Promise<void> => {
    if (!inventory) return;
    if (volume.availableBytes < requiredBytes(inventory)) {
      setError(`The selected volume does not have enough free space. It needs ${formatBytes(requiredBytes(inventory))}.`);
      return;
    }
    await runPrepare(volume.mountPoint);
  };

  const runToolsInspect = async (value: string): Promise<void> => {
    try {
      setError(undefined);
      const {inventory: result} = await inventoryTakeout(value.trim());
      setToolsSource(path.resolve(value.trim()));
      setToolsInventory(result);
      setScreen('tools-inspect-result');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const runToolsPrepare = async (source: string, volume: string): Promise<void> => {
    try {
      setError(undefined);
      setToolsSource(path.resolve(source.trim()));
      setToolsVolume(path.resolve(volume.trim()));
      setScreen('tools-prepare-running');
      const result = await prepareBundle(path.resolve(volume.trim()), source.trim(), setProgress);
      setProgress(result);
      setScreen('tools-prepare-result');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setScreen('tools-prepare-volume');
    }
  };

  const runToolsStatus = async (volume: string): Promise<void> => {
    try {
      setError(undefined);
      setToolsVolume(path.resolve(volume.trim()));
      const manifest = await getBundleStatus(path.resolve(volume.trim()));
      setToolsManifest(manifest);
      setScreen('tools-status-result');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const runToolsReport = async (volume: string): Promise<void> => {
    try {
      setError(undefined);
      setToolsVolume(path.resolve(volume.trim()));
      const destination = await writeBundleReport(path.resolve(volume.trim()));
      setToolsReportPath(destination);
      setScreen('tools-report-result');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return <Box flexDirection="column" padding={1} gap={1}>
    <Banner/>
    {error && <Alert variant="error">{error}</Alert>}
    {screen === 'checking-update' && <Spinner label="Checking for updates..."/>}
    {screen === 'update-available' && availableUpdate && <><StatusMessage variant="info">{`Version ${availableUpdate.version} is available.`}</StatusMessage><Text>{`Update from ${VERSION} now?`}</Text><ConfirmInput defaultChoice="cancel" onConfirm={() => void applyUpdate()} onCancel={() => setScreen('menu')}/></>}
    {screen === 'updating' && <Spinner label="Downloading and installing the update..."/>}
    {screen === 'update-complete' && <><StatusMessage variant="success">Update installed successfully.</StatusMessage><Text>Restart gfotos-migrator to use the new version.</Text><ConfirmInput defaultChoice="confirm" onConfirm={() => process.exit(0)} onCancel={() => process.exit(0)}/></>}

    {screen === 'menu' && <>
      <Text>Prepare a portable Import Bundle from Google Takeout, ready for a manual import into Photos.</Text>
      <Select options={[{label: 'Start guided migration', value: 'start'}, {label: 'Tools', value: 'tools'}]} onChange={value => {
        setError(undefined);
        if (value === 'start') setScreen('source');
        else setScreen('tools');
      }}/>
    </>}

    {screen === 'tools' && <>
      <Text bold>Tools</Text>
      <Select options={[
        {label: 'Inspect Takeout', value: 'inspect'},
        {label: 'Prepare or resume Import Bundle', value: 'prepare'},
        {label: 'Status', value: 'status'},
        {label: 'Report', value: 'report'},
        {label: 'Back', value: 'back'}
      ]} onChange={value => {
        setError(undefined);
        if (value === 'inspect') setScreen('tools-inspect-source');
        else if (value === 'prepare') setScreen('tools-prepare-source');
        else if (value === 'status') setScreen('tools-status-volume');
        else if (value === 'report') setScreen('tools-report-volume');
        else setScreen('menu');
      }}/>
    </>}

    {screen === 'source' && <><Text>Enter the folder containing Google Takeout ZIP archives:</Text><TextInput placeholder="/Volumes/External/Takeout" onSubmit={inspectSource}/></>}

    {screen === 'select-volume' && inventory && <>
      <Text bold>Select the external destination volume for the Import Bundle.</Text>
      <Text dimColor>System volumes, Time Machine destinations, and read-only volumes are excluded. Any writable filesystem with enough free space works — no APFS or formatting is required.</Text>
      <Text>{`Required free space: ${formatBytes(requiredBytes(inventory))}.`}</Text>
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
      <Text>Connect an external, writable volume and try again.</Text>
      <Select options={[
        {label: 'Try again', value: 'retry'},
        {label: 'Cancel migration', value: 'cancel'}
      ]} onChange={value => {
        if (value === 'retry') void loadExternalVolumes();
        else setScreen('menu');
      }}/>
    </>}

    {screen === 'preparing' && <><Spinner label="Preparing the Import Bundle..."/><ProgressBar value={progress ? (progress.completed / Math.max(progress.total, 1)) * 100 : 0}/><Text>{progress ? `${progress.completed}/${progress.total} processed · ${progress.materialized} materialized · ${progress.duplicate} duplicate · ${progress.failed} failed` : 'Preparing...'}</Text>{progress?.current && <Text dimColor>{progress.current}</Text>}</>}

    {screen === 'complete' && progress && <>
      <StatusMessage variant={progress.failed > 0 ? 'warning' : 'success'}>Import Bundle prepared.</StatusMessage>
      <Text>{`Bundle folder: ${path.join(volumePath, 'import')}`}</Text>
      <Text>{`Verification: ${progress.failed > 0 ? `${progress.failed} item(s) need review, see the report` : 'all items verified with SHA-256'}`}</Text>
      <Text>{`Summary: ${progress.materialized} materialized · ${progress.duplicate} duplicate · ${progress.failed} failed · ${progress.skipped} skipped`}</Text>
      <Text bold>Manual action: open Photos, choose File &gt; Import, and select the import/ folder above.</Text>
      <ConfirmInput onConfirm={() => process.exit(0)} onCancel={() => process.exit(0)}/>
    </>}

    {screen === 'tools-inspect-source' && <><Text>Enter the folder containing Google Takeout ZIP archives:</Text><TextInput placeholder="/Volumes/External/Takeout" onSubmit={value => void runToolsInspect(value)}/></>}
    {screen === 'tools-inspect-result' && toolsInventory && <>
      <StatusMessage variant="success">Inspection complete.</StatusMessage>
      <Text>{`Source: ${toolsSource}`}</Text>
      <Text>{`${toolsInventory.images} photos, ${toolsInventory.videos} videos, ${toolsInventory.archives} ZIP archives.`}</Text>
      <Text>{`Required free space: ${formatBytes(requiredBytes(toolsInventory))}.`}</Text>
      <ConfirmInput onConfirm={() => setScreen('tools')} onCancel={() => setScreen('tools')}/>
    </>}

    {screen === 'tools-prepare-source' && <><Text>Enter the folder containing Google Takeout ZIP archives:</Text><TextInput placeholder="/Volumes/External/Takeout" onSubmit={value => { setToolsSource(value); setScreen('tools-prepare-volume'); }}/></>}
    {screen === 'tools-prepare-volume' && <><Text>Enter the destination volume path:</Text><TextInput placeholder="/Volumes/External" onSubmit={value => void runToolsPrepare(toolsSource, value)}/></>}
    {screen === 'tools-prepare-running' && <><Spinner label="Preparing the Import Bundle..."/><ProgressBar value={progress ? (progress.completed / Math.max(progress.total, 1)) * 100 : 0}/><Text>{progress ? `${progress.completed}/${progress.total} processed · ${progress.materialized} materialized · ${progress.duplicate} duplicate · ${progress.failed} failed` : 'Preparing...'}</Text></>}
    {screen === 'tools-prepare-result' && progress && <>
      <StatusMessage variant={progress.failed > 0 ? 'warning' : 'success'}>Import Bundle prepared.</StatusMessage>
      <Text>{`Bundle folder: ${path.join(toolsVolume, 'import')}`}</Text>
      <Text>{`Summary: ${progress.materialized} materialized · ${progress.duplicate} duplicate · ${progress.failed} failed · ${progress.skipped} skipped`}</Text>
      <ConfirmInput onConfirm={() => setScreen('tools')} onCancel={() => setScreen('tools')}/>
    </>}

    {screen === 'tools-status-volume' && <><Text>Enter the volume path to inspect:</Text><TextInput placeholder="/Volumes/External" onSubmit={value => void runToolsStatus(value)}/></>}
    {screen === 'tools-status-result' && toolsManifest && <>
      <StatusMessage variant="success">Bundle status loaded.</StatusMessage>
      <Text>{`Volume: ${toolsVolume}`}</Text>
      <Text>{`Materialized: ${toolsManifest.counts.materialized} · Duplicate: ${toolsManifest.counts.duplicate} · Failed: ${toolsManifest.counts.failed} · Skipped: ${toolsManifest.counts.skipped} · Pending: ${toolsManifest.counts.pending}`}</Text>
      <ConfirmInput onConfirm={() => setScreen('tools')} onCancel={() => setScreen('tools')}/>
    </>}

    {screen === 'tools-report-volume' && <><Text>Enter the volume path to report on:</Text><TextInput placeholder="/Volumes/External" onSubmit={value => void runToolsReport(value)}/></>}
    {screen === 'tools-report-result' && toolsReportPath && <>
      <StatusMessage variant="success">Report written.</StatusMessage>
      <Text>{toolsReportPath}</Text>
      <ConfirmInput onConfirm={() => setScreen('tools')} onCancel={() => setScreen('tools')}/>
    </>}
  </Box>;
}

export async function runTui(): Promise<void> {
  const instance = render(<App/>);
  await instance.waitUntilExit();
}
