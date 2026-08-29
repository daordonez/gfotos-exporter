#!/usr/bin/env bash

set -euo pipefail

readonly REPOSITORY="daordonez/gfotos-exporter"
readonly RELEASES_API_URL="https://api.github.com/repos/${REPOSITORY}/releases?per_page=3"
readonly RELEASE_API_BASE_URL="https://api.github.com/repos/${REPOSITORY}/releases/tags"
readonly RELEASE_ASSET_API_URL="https://api.github.com/repos/${REPOSITORY}/releases/assets"
readonly GITHUB_API_VERSION="2022-11-28"
readonly REQUIRED_NODE_MAJOR=22
readonly REQUIRED_NODE_MINOR=13
readonly NODE_VERSION="22.13.0"
readonly USER_PREFIX="${HOME}/.local"
readonly NODE_INSTALL_ROOT="${USER_PREFIX}/opt/gfotos-migrator/node-v${NODE_VERSION}"

SELECTED_RELEASE_TAG=""
SELECTED_PACKAGE_NAME=""

log() {
  printf '%s\n' "[gfotos-migrator] $*"
}

fail() {
  printf '%s\n' "[gfotos-migrator] ERROR: $*" >&2
  exit 1
}

require_supported_platform() {
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) fail "Unsupported operating system: $(uname -s)." ;;
  esac
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "Administrator privileges are required to install $1."
  fi
}

linux_package_manager() {
  for manager in apt-get dnf yum pacman zypper; do
    if command -v "$manager" >/dev/null 2>&1; then
      printf '%s\n' "$manager"
      return
    fi
  done

  fail "No supported Linux package manager was found."
}

install_linux_package() {
  local package_name="$1"
  local manager
  manager="$(linux_package_manager)"

  case "$manager" in
    apt-get)
      run_as_root apt-get update
      run_as_root apt-get install -y "$package_name"
      ;;
    dnf)
      run_as_root dnf install -y "$package_name"
      ;;
    yum)
      run_as_root yum install -y "$package_name"
      ;;
    pacman)
      run_as_root pacman -Sy --noconfirm "$package_name"
      ;;
    zypper)
      run_as_root zypper --non-interactive install "$package_name"
      ;;
  esac
}

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    return
  fi

  log "Installing Homebrew. You may be asked for your administrator password."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  command -v brew >/dev/null 2>&1 || fail "Homebrew installation did not complete successfully."
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi

  case "$(uname -s)" in
    Darwin)
      ensure_homebrew
      brew install curl
      ;;
    Linux)
      install_linux_package curl
      ;;
  esac
}

node_version_is_supported() {
  local version major minor
  version="$(node --version | sed 's/^v//')"
  major="${version%%.*}"
  version="${version#*.}"
  minor="${version%%.*}"

  [ "$major" -gt "$REQUIRED_NODE_MAJOR" ] || {
    [ "$major" -eq "$REQUIRED_NODE_MAJOR" ] && [ "$minor" -ge "$REQUIRED_NODE_MINOR" ]
  }
}

append_path_to_profile() {
  local profile="$1"
  local path_entries="$2"
  local marker="# Added by gfotos-migrator installer"

  if [ -f "$profile" ] && grep -Fqx "$marker" "$profile"; then
    return
  fi

  {
    printf '\n%s\n' "$marker"
    printf 'export PATH="%s:$PATH"\n' "$path_entries"
  } >> "$profile"
}

persist_path() {
  local path_entries="$1"

  case "$(uname -s)" in
    Darwin)
      append_path_to_profile "${HOME}/.zprofile" "$path_entries"
      ;;
    Linux)
      append_path_to_profile "${HOME}/.profile" "$path_entries"
      ;;
  esac
}

node_archive_name() {
  local os architecture
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"

  case "$(uname -m)" in
    x86_64|amd64) architecture="x64" ;;
    arm64|aarch64) architecture="arm64" ;;
    *) fail "Unsupported processor architecture: $(uname -m)." ;;
  esac

  printf 'node-v%s-%s-%s.tar.xz\n' "$NODE_VERSION" "$os" "$architecture"
}

install_portable_node() {
  local archive archive_url checksums_url expected_checksum actual_checksum cache_dir
  archive="$(node_archive_name)"
  archive_url="https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
  checksums_url="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  cache_dir="${HOME}/.cache/gfotos-migrator"

  mkdir -p "$cache_dir" "${USER_PREFIX}/opt"
  log "Installing Node.js ${NODE_VERSION} in ${NODE_INSTALL_ROOT}."
  curl --fail --location --retry 3 --output "${cache_dir}/${archive}" "$archive_url"
  curl --fail --location --retry 3 --output "${cache_dir}/SHASUMS256.txt" "$checksums_url"

  expected_checksum="$(awk -v archive="$archive" '$2 == archive { print $1 }' "${cache_dir}/SHASUMS256.txt")"
  [ -n "$expected_checksum" ] || fail "Could not find the Node.js archive checksum."

  if command -v shasum >/dev/null 2>&1; then
    actual_checksum="$(shasum -a 256 "${cache_dir}/${archive}" | awk '{ print $1 }')"
  else
    actual_checksum="$(sha256sum "${cache_dir}/${archive}" | awk '{ print $1 }')"
  fi

  [ "$expected_checksum" = "$actual_checksum" ] || fail "Node.js archive checksum verification failed."

  rm -rf "$NODE_INSTALL_ROOT"
  tar -xJf "${cache_dir}/${archive}" -C "${USER_PREFIX}/opt"
  mv "${USER_PREFIX}/opt/${archive%.tar.xz}" "$NODE_INSTALL_ROOT"
  export PATH="${NODE_INSTALL_ROOT}/bin:${PATH}"
  persist_path "${NODE_INSTALL_ROOT}/bin:${USER_PREFIX}/bin"
}

ensure_node_and_npm() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node_version_is_supported; then
    return
  fi

  ensure_curl
  case "$(uname -s)" in
    Darwin)
      ensure_homebrew
      brew install node@22
      export PATH="$(brew --prefix node@22)/bin:${PATH}"
      persist_path "$(brew --prefix node@22)/bin:${USER_PREFIX}/bin"
      ;;
    Linux)
      install_portable_node
      ;;
  esac

  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node_version_is_supported || fail "Node.js ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} or newer is required."
}

ensure_exiftool() {
  if command -v exiftool >/dev/null 2>&1; then
    return
  fi

  log "Installing ExifTool."
  case "$(uname -s)" in
    Darwin)
      ensure_homebrew
      brew install exiftool
      ;;
    Linux)
      case "$(linux_package_manager)" in
        apt-get) install_linux_package libimage-exiftool-perl ;;
        dnf|yum) install_linux_package perl-Image-ExifTool ;;
        pacman) install_linux_package perl-image-exiftool ;;
        zypper) install_linux_package perl-Image-ExifTool ;;
      esac
      ;;
  esac

  command -v exiftool >/dev/null 2>&1 || fail "ExifTool installation did not complete successfully."
}

github_api_get() {
  local url="$1"
  local accept_header="$2"
  local destination="$3"

  curl --fail --location --retry 3 \
    --header "Accept: ${accept_header}" \
    --header "X-GitHub-Api-Version: ${GITHUB_API_VERSION}" \
    --output "$destination" \
    "$url"
}

select_release() {
  local metadata_path candidates_path release_count selected_option tag published_at
  local -a release_tags

  metadata_path="$(mktemp)"
  candidates_path="$(mktemp)"

  log "Retrieving available releases."
  github_api_get "$RELEASES_API_URL" "application/vnd.github+json" "$metadata_path"

  node --input-type=module --eval '
    import { readFileSync } from "node:fs";
    const releases = JSON.parse(readFileSync(process.argv[1], "utf8"));
    for (const release of releases.filter(({ draft }) => !draft).slice(0, 3)) {
      process.stdout.write(`${release.tag_name}\t${release.published_at || release.created_at}\n`);
    }
  ' "$metadata_path" > "$candidates_path"
  rm -f "$metadata_path"

  release_count=0
  printf '\nAvailable releases (newest first):\n' >&2
  while IFS=$'\t' read -r tag published_at; do
    release_count=$((release_count + 1))
    release_tags[$release_count]="$tag"
    printf '%s) %s (%s)\n' "$release_count" "$tag" "$published_at" >&2
  done < "$candidates_path"
  rm -f "$candidates_path"

  [ "$release_count" -gt 0 ] || fail "No published releases are available."

  selected_option=1
  if [ -t 0 ]; then
    printf 'Select a release [1]: ' >&2
    IFS= read -r selected_option || selected_option=""
    selected_option="${selected_option:-1}"
  else
    log "No interactive terminal detected. Selecting the newest release: ${release_tags[1]}."
  fi

  case "$selected_option" in
    *[!0-9]*|'') fail "The release selection must be a number between 1 and ${release_count}." ;;
  esac

  [ "$selected_option" -ge 1 ] && [ "$selected_option" -le "$release_count" ] || fail "The release selection must be a number between 1 and ${release_count}."

  SELECTED_RELEASE_TAG="${release_tags[$selected_option]}"
  SELECTED_PACKAGE_NAME="gfotos-migrator-${SELECTED_RELEASE_TAG#v}.tgz"
  log "Selected release: ${SELECTED_RELEASE_TAG}."
}

download_release() {
  local destination="$1"
  local metadata_path asset_id release_api_url

  metadata_path="$(mktemp)"
  release_api_url="${RELEASE_API_BASE_URL}/${SELECTED_RELEASE_TAG}"

  log "Downloading gfotos-migrator ${SELECTED_RELEASE_TAG}."
  github_api_get "$release_api_url" "application/vnd.github+json" "$metadata_path"

  asset_id="$(node --input-type=module --eval '
    import { readFileSync } from "node:fs";
    const [metadataPath, packageName] = process.argv.slice(1);
    const release = JSON.parse(readFileSync(metadataPath, "utf8"));
    const asset = release.assets.find(({ name }) => name === packageName);
    if (!asset) process.exit(2);
    process.stdout.write(String(asset.id));
  ' "$metadata_path" "$SELECTED_PACKAGE_NAME")"
  rm -f "$metadata_path"

  [ -n "$asset_id" ] || fail "The requested release asset was not found."

  github_api_get "${RELEASE_ASSET_API_URL}/${asset_id}" "application/octet-stream" "$destination"
}

install_package() {
  local temporary_directory package_path
  temporary_directory="$(mktemp -d)"
  package_path="${temporary_directory}/${SELECTED_PACKAGE_NAME}"
  trap 'rm -rf "$temporary_directory"' EXIT

  download_release "$package_path"
  npm config set prefix "$USER_PREFIX"
  export PATH="${USER_PREFIX}/bin:${PATH}"
  persist_path "${USER_PREFIX}/bin"
  npm install --global "$package_path"
  command -v gfotos-migrator >/dev/null 2>&1 || fail "Installation completed but gfotos-migrator is not on PATH."
}

main() {
  [ "$#" -eq 0 ] || fail "This installer does not accept arguments."
  require_supported_platform
  ensure_node_and_npm
  ensure_exiftool
  select_release
  install_package

  log "Installation completed successfully."
  log "Run: gfotos-migrator guided-migration"
  if [ "$(uname -s)" != "Darwin" ]; then
    log "Note: the migration workflow requires macOS and the Photos application."
  fi
}

main "$@"
