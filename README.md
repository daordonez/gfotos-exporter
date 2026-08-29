# gfotos-migrator

Herramienta local para macOS que importa archivos ZIP de Google Photos Takeout a una fototeca aislada en un volumen APFS externo. No modifica la fototeca principal durante la migración.

## Instalación

El instalador prepara automáticamente Node.js, npm y ExifTool, muestra las tres releases publicadas más recientes y deja `gfotos-migrator` disponible para el usuario actual. La opción predeterminada al pulsar Intro es siempre la release más reciente.

1. Crea un [personal access token fine-grained según la documentación oficial de GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token).
2. Configúralo con el mínimo privilegio:
   - **Resource owner:** `daordonez`.
   - **Repository access:** `Only select repositories` y selecciona `gfotos-exporter`.
   - **Repository permissions:** **Contents** = `Read-only`.
   - No concedas permisos adicionales. **Metadata: Read-only** es un permiso obligatorio que GitHub añade automáticamente.
3. Desde la raíz del repositorio, ejecuta una de estas opciones:

```sh
chmod +x install-gfotos-migrator.sh
./install-gfotos-migrator.sh
```

El script solicitará el token sin mostrarlo. Para usarlo de forma no interactiva, indica explícitamente el parámetro:

```sh
./install-gfotos-migrator.sh --GHTOKEN "YOUR_GITHUB_TOKEN"
```

4. Abre una nueva terminal si era necesario y verifica la instalación:

```sh
gfotos-migrator --help
```

El script admite macOS y Linux para la instalación de dependencias. La migración en sí requiere macOS, Photos y un volumen APFS externo.

## Uso

Inicia el flujo guiado:

```sh
gfotos-migrator guided-migration
```

La fototeca de destino es `GoogleTakeoutMigration.photoslibrary`. Debe permanecer fuera de iCloud Photos y no puede ser la Fototeca del Sistema. Los ZIP de Takeout se tratan como entrada de solo lectura.

When selecting a destination, guided migration lists mounted external volumes and shows their filesystem and free capacity. It excludes system volumes, Time Machine destinations, and read-only volumes. A non-APFS volume, or an APFS volume without enough space, can be erased and converted to APFS only after exact whole-disk confirmation. The default descriptive volume name is `GPhotos_Export` and can be changed before formatting. If no selectable volume is connected, guided migration ends without changing any disk.

Para borrar y preparar un disco externo, usa `prepare-volume` únicamente después de verificar el identificador con Utilidad de Discos o `diskutil list`: esta operación elimina todo el contenido del disco seleccionado.

## Desarrollo

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```
