import path from 'node:path';
import {exists} from './system.js';
import React, {useEffect, useState} from 'react';
import {Box, render, Text} from 'ink';
import {Alert, ConfirmInput, ProgressBar, Select, Spinner, StatusMessage, TextInput} from '@inkjs/ui';
import {exifToolAvailable, installExifTool} from './media.js';
import {importCandidates, initializePaths, requiredBytes, type ImportProgress} from './migration.js';
import {openPhotosLibrary} from './photos.js';
import {inventoryTakeout} from './takeout.js';
import {checkForUpdate, installUpdate, type AvailableUpdate} from './updates.js';
import {VERSION} from './version.js';
import {eraseExternalDisk, listExternalWholeDisks, validateExternalApfs, volumeMountPath, type ExternalDisk} from './volume.js';
import type {MediaCandidate, TakeoutInventory} from './domain.js';

type Screen = 'checking-update' | 'update-available' | 'updating' | 'update-complete' | 'menu' | 'source' | 'storage' | 'existing-volume' | 'select-disk' | 'volume-name' | 'erase-confirmation' | 'formatting' | 'dependency' | 'installing-dependency' | 'library' | 'confirm' | 'running' | 'complete';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = -1;
  do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(1)} ${units[index]}`;
}

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('checking-update');
  const [sourcePath, setSourcePath] = useState('');
  const [volumePath, setVolumePath] = useState('');
  const [volumeName, setVolumeName] = useState('GoogleMigration');
  const [selectedDisk, setSelectedDisk] = useState<ExternalDisk>();
  const [externalDisks, setExternalDisks] = useState<ExternalDisk[]>([]);
  const [inventory, setInventory] = useState<TakeoutInventory>();
  const [candidates, setCandidates] = useState<MediaCandidate[]>([]);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<ImportProgress>();
  const [libraryReady, setLibraryReady] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate>();

  const checkUpdates = async (): Promise<void> => {
    try {
      const update = await checkForUpdate(VERSION);
      if (update) {
        setAvailableUpdate(update);
        setScreen('update-available');
        return;
      }
    } catch {
      // A network or authentication failure must not block a local migration.
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

  const continueAfterStorage = async (): Promise<void> => {
    if (await exifToolAvailable()) setScreen('library');
    else setScreen('dependency');
  };

  const inspectSource = async (value: string): Promise<void> => {
    try {
      setError(undefined);
      const result = await inventoryTakeout(value.trim());
      if (result.inventory.archives === 0) throw new Error('No ZIP archives were found in the selected path.');
      if (result.media.length === 0) throw new Error('No supported photos or videos were found in the ZIP archives.');
      setSourcePath(path.resolve(value.trim()));
      setInventory(result.inventory);
      setCandidates(result.media);
      setScreen('storage');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };

  const inspectVolume = async (value: string): Promise<void> => {
    try {
      if (!inventory) return;
      setError(undefined);
      await validateExternalApfs(value.trim(), requiredBytes(inventory));
      setVolumePath(path.resolve(value.trim()));
      await continueAfterStorage();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };

  const loadExternalDisks = async (): Promise<void> => {
    try {
      setError(undefined);
      setExternalDisks(await listExternalWholeDisks());
      setScreen('select-disk');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };

  const prepareVolume = async (): Promise<void> => {
    if (!selectedDisk || !inventory) return;
    try {
      setError(undefined);
      setScreen('formatting');
      const mountPath = volumeMountPath(volumeName);
      await eraseExternalDisk(selectedDisk.deviceIdentifier, volumeName.trim());
      await validateExternalApfs(mountPath, requiredBytes(inventory));
      setVolumePath(mountPath);
      await continueAfterStorage();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setScreen('erase-confirmation');
    }
  };

  const installDependency = async (): Promise<void> => {
    try {
      setError(undefined);
      setScreen('installing-dependency');
      await installExifTool();
      if (!await exifToolAvailable()) throw new Error('ExifTool installation completed but the command is not available. Restart the terminal and resume guided migration.');
      setScreen('library');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setScreen('dependency');
    }
  };

  const startMigration = async (): Promise<void> => {
    try {
      setScreen('running');
      const paths = await initializePaths(volumePath);
      await openPhotosLibrary(paths.libraryPath);
      await importCandidates(paths, candidates, setProgress);
      setScreen('complete');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setScreen('confirm');
    }
  };

  useEffect(() => {
    if (screen !== 'library') return;
    const interval = setInterval(async () => setLibraryReady(await exists(path.join(volumePath, 'GoogleTakeoutMigration.photoslibrary'))), 1000);
    return () => clearInterval(interval);
  }, [screen, volumePath]);

  return <Box flexDirection="column" padding={1} gap={1}>
    <Text color="cyan" bold>gfotos-migrator</Text>
    {error && <Alert variant="error">{error}</Alert>}
    {screen === 'checking-update' && <Spinner label="Checking for updates..."/>}
    {screen === 'update-available' && availableUpdate && <><StatusMessage variant="info">{`Version ${availableUpdate.version} is available.`}</StatusMessage><Text>{`Update from ${VERSION} now?`}</Text><ConfirmInput defaultChoice="cancel" onConfirm={() => void applyUpdate()} onCancel={() => setScreen('menu')}/></>}
    {screen === 'updating' && <Spinner label="Downloading and installing the update..."/>}
    {screen === 'update-complete' && <><StatusMessage variant="success">Update installed successfully.</StatusMessage><Text>Restart gfotos-migrator to use the new version.</Text><ConfirmInput defaultChoice="confirm" onConfirm={() => process.exit(0)} onCancel={() => process.exit(0)}/></>}
    {screen === 'menu' && <>
      <Text>Safe Google Takeout migration to an isolated Photos library.</Text>
      <Select options={[{label: 'Start guided migration', value: 'start'}, {label: 'Exit', value: 'exit'}]} onChange={value => {
        if (value === 'start') setScreen('source');
        else process.exit(0);
      }}/>
    </>}
    {screen === 'source' && <><Text>Enter the folder containing Google Takeout ZIP archives:</Text><TextInput placeholder="/Volumes/External/Takeout" onSubmit={inspectSource}/></>}
    {screen === 'storage' && inventory && <>
      <Text>{`${inventory.images} photos, ${inventory.videos} videos, ${inventory.archives} ZIP archives.`}</Text>
      <Text>{`Required external free space: ${formatBytes(requiredBytes(inventory))}.`}</Text>
      <Text bold>Migration storage must be an external APFS volume.</Text>
      <Select options={[
        {label: 'Prepare an external disk now (erases that disk)', value: 'prepare'},
        {label: 'Use an existing external APFS volume', value: 'existing'},
        {label: 'Cancel migration', value: 'cancel'}
      ]} onChange={value => {
        if (value === 'prepare') void loadExternalDisks();
        else if (value === 'existing') setScreen('existing-volume');
        else setScreen('menu');
      }}/>
    </>}
    {screen === 'existing-volume' && <><Text>Enter the mounted path of the external APFS volume:</Text><TextInput placeholder="/Volumes/GoogleMigration" onSubmit={inspectVolume}/></>}
    {screen === 'select-disk' && <>
      <Text bold>Select the external physical disk to erase and format as APFS.</Text>
      <Text color="red">All data on the selected disk will be permanently erased.</Text>
      {externalDisks.length > 0 ? <Select visibleOptionCount={8} options={externalDisks.map(disk => ({label: `${disk.deviceIdentifier} — ${disk.name} — ${formatBytes(disk.capacityBytes)}`, value: disk.deviceIdentifier}))} onChange={identifier => {
        const disk = externalDisks.find(candidate => candidate.deviceIdentifier === identifier);
        if (!disk || !inventory) return;
        if (disk.capacityBytes < requiredBytes(inventory)) {
          setError(`The selected disk capacity is below the required migration space of ${formatBytes(requiredBytes(inventory))}.`);
          return;
        }
        setSelectedDisk(disk);
        setScreen('volume-name');
      }}/> : <StatusMessage variant="warning">No eligible external physical disks were found. Connect one and restart guided migration.</StatusMessage>}
    </>}
    {screen === 'volume-name' && <><Text>{`APFS volume name for ${selectedDisk?.deviceIdentifier ?? 'the selected disk'}:`}</Text><TextInput defaultValue={volumeName} onSubmit={value => {
      try { volumeMountPath(value); setVolumeName(value.trim()); setScreen('erase-confirmation'); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    }}/></>}
    {screen === 'erase-confirmation' && <>
      <Text color="red" bold>{`Last warning: ${selectedDisk?.deviceIdentifier} (${selectedDisk?.name}) will be erased permanently.`}</Text>
      <Text>{`Type ${selectedDisk?.deviceIdentifier} exactly to create the APFS volume “${volumeName}”: `}</Text>
      <TextInput onSubmit={value => {
        if (value.trim() !== selectedDisk?.deviceIdentifier) { setError('The disk identifier did not match. No disk was changed.'); return; }
        void prepareVolume();
      }}/>
    </>}
    {screen === 'formatting' && <Spinner label="Erasing the selected disk and creating the APFS migration volume..."/>}
    {screen === 'dependency' && <><StatusMessage variant="warning">ExifTool is required to restore Google Takeout capture dates.</StatusMessage><Text>Install ExifTool now with Homebrew? This does not modify your photos or migration disk.</Text><ConfirmInput defaultChoice="cancel" onConfirm={() => void installDependency()} onCancel={() => setScreen('menu')}/></>}
    {screen === 'installing-dependency' && <Spinner label="Installing ExifTool with Homebrew..."/>}
    {screen === 'library' && <>
      <Text bold>Create the isolated library in Photos now.</Text>
      <Text>Quit Photos, hold Option while opening it, select Create New, and use:</Text>
      <Text color="yellow">{path.join(volumePath, 'GoogleTakeoutMigration.photoslibrary')}</Text>
      <Text>Do not make it the System Photo Library and do not enable iCloud Photos.</Text>
      {libraryReady ? <ConfirmInput onConfirm={() => setScreen('confirm')} onCancel={() => setScreen('menu')}/> : <Spinner label="Waiting for the new library to appear..."/>}
    </>}
    {screen === 'confirm' && inventory && <><StatusMessage variant="info">The main Photos library and iCloud will not be modified.</StatusMessage><Text>{`Import ${inventory.images} photos and ${inventory.videos} videos into the isolated library?`}</Text><ConfirmInput defaultChoice="cancel" onConfirm={() => void startMigration()} onCancel={() => setScreen('menu')}/></>}
    {screen === 'running' && <><Spinner label="Importing into the open isolated Photos library..."/><ProgressBar value={progress ? (progress.completed / Math.max(progress.total, 1)) * 100 : 0}/><Text>{progress ? `${progress.completed}/${progress.total} processed · ${progress.imported} imported · ${progress.skipped} skipped · ${progress.failed} failed` : 'Preparing...'}</Text>{progress?.current && <Text dimColor>{progress.current.entryPath}</Text>}</>}
    {screen === 'complete' && <><StatusMessage variant="success">Migration completed. Review the isolated library before using handoff-check.</StatusMessage><Text>{`Source: ${sourcePath}`}</Text><Text>{`Library: ${path.join(volumePath, 'GoogleTakeoutMigration.photoslibrary')}`}</Text></>}
  </Box>;
}

export async function runTui(): Promise<void> {
  const instance = render(<App/>);
  await instance.waitUntilExit();
}
