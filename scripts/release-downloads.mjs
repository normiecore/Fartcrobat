// The file each person downloads from a release: one per kind of computer (README.md, Install).
// The release workflow checks that every build made its files and no other installer, and puts the
// table at the top of the release notes.
//   node scripts/release-downloads.mjs [--dir release] [--version 0.2.1] [--platform win|mac|linux]
//   node scripts/release-downloads.mjs --dir dist --version 0.2.1 --notes    (prints the notes section)
// --version defaults to package.json's. Exits 1, listing the problems, when a file is missing or
// --dir holds an installer the table does not name.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = 'normiecore/Fartcrobat'

/** Who downloads which file, in the order the table lists them. */
export function releaseDownloads(version) {
  return [
    { platform: 'win', computer: 'Windows (most PCs)', file: `Fartcrobat-Setup-${version}-x64.exe` },
    { platform: 'win', computer: 'Windows on Arm (Snapdragon, Surface Pro X)', file: `Fartcrobat-Setup-${version}-arm64.exe` },
    { platform: 'mac', computer: 'Mac with Apple silicon (M1 or later)', file: `Fartcrobat-${version}-arm64.dmg` },
    { platform: 'mac', computer: 'Mac with an Intel processor', file: `Fartcrobat-${version}-x64.dmg` },
    { platform: 'linux', computer: 'Ubuntu, Debian, Linux Mint, Pop!_OS', file: `fartcrobat_${version}_amd64.deb` },
    { platform: 'linux', computer: 'Other Linux (Fedora, Arch, openSUSE...)', file: 'Fartcrobat-x86_64.AppImage' }
  ]
}

/** Installers someone could pick by mistake: every one in a build must be in the table. */
const INSTALLER = { win: /\.exe$/i, mac: /\.dmg$/i, linux: /\.(deb|AppImage|rpm|snap)$/i }

/** The problems with a build's files (`files`: the names in its output folder), else []. */
export function checkDownloads(files, version, platform) {
  const platforms = platform ? [platform] : Object.keys(INSTALLER)
  const expected = releaseDownloads(version).filter((d) => platforms.includes(d.platform))
  const problems = expected.filter((d) => !files.includes(d.file)).map((d) => `${d.file} (${d.computer}) is missing`)
  for (const name of files) {
    // electron-builder leaves its uninstaller next to the Windows installers.
    if (name.startsWith('__uninstaller')) continue
    if (platforms.some((p) => INSTALLER[p].test(name)) && !expected.some((d) => d.file === name))
      problems.push(`${name} is an installer the download table does not name: people would have to guess which one to run`)
  }
  return problems
}

/** The Download section at the top of a release's notes. */
export function releaseNotes(version) {
  const url = (file) => `https://github.com/${REPO}/releases/download/v${version}/${file}`
  const rows = releaseDownloads(version).map((d) => `| ${d.computer} | [${d.file}](${url(d.file)}) |`)
  return [
    '## Download',
    '',
    'Download the one file for your computer and open it.',
    '',
    '| Your computer | File |',
    '| --- | --- |',
    ...rows,
    '',
    'Not sure which? On Windows, Settings > System > About says "x64-based processor" or "ARM-based processor". ' +
      'On a Mac, Apple menu > About This Mac says "Chip Apple M..." for Apple silicon or "Processor ... Intel".',
    '',
    'The installers are not code signed yet. Windows may say "Windows protected your PC": choose More info, then Run anyway. ' +
      'macOS may say it could not verify Fartcrobat: open System Settings > Privacy & Security and choose Open Anyway.',
    '',
    `On Ubuntu and Debian, open the .deb with App Center or run \`sudo apt install ./fartcrobat_${version}_amd64.deb\`. ` +
      'The AppImage updates itself and needs FUSE 2 (on Ubuntu 22.04 and later: `sudo apt install libfuse2t64`, or `libfuse2` before 24.04).',
    '',
    'The other files are for in-app updates (.zip, .blockmap, latest*.yml) and for unpacking by hand (.tar.gz).',
    ''
  ].join('\n')
}

function main(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '')
    if (name === 'notes') args.notes = true
    else args[name] = argv[++i]
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const version = args.version ?? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  if (args.platform && !INSTALLER[args.platform]) {
    console.error(`--platform must be one of ${Object.keys(INSTALLER).join(', ')}`)
    return 2
  }
  const problems = checkDownloads(readdirSync(resolve(args.dir ?? 'release')), version, args.platform)
  for (const p of problems) console.error(`release-downloads: ${p}`)
  if (problems.length) return 1
  if (args.notes) process.stdout.write(releaseNotes(version))
  else console.error(`release-downloads: every ${args.platform ? `${args.platform} ` : ''}download for ${version} is there`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))
