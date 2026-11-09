#!/usr/bin/env node
// The names a release of the app has, from its version (README.md, "Two names"): up to 0.3 it
// shipped as Fartcrobat, from 0.4.0 on as Inkmoor (docs/features/rename.md). A rehearsal installs a
// release under one name and updates it to a build that may have the other, so every file name,
// path and window global it uses comes from here, for the side it is about. The specs import it
// (names.d.mts); the workflow and linux.sh run it:
//
//   node names.mjs <version> <field>      prints one field of productFor(<version>), e.g. winSetupX64
//   node names.mjs default-new <old>      the version to rehearse when none is given: the next patch
//                                         version, or the first version under the checkout's name
//                                         when the next patch version would still have the old one
//   node names.mjs check-build <new>      exits 1 when a build of this checkout, versioned <new>,
//                                         would not have the names <new> stands for
//   node names.mjs same-repo <old> <new>  exits 1 when <old> asks another repository than <new>
//                                         publishes to: no rehearsal can update across that
//
// The GitHub repository was normiecore/Fartcrobat up to 0.4.0 and is normiecore/Inkmoor from 0.4.1
// (src/shared/identity.ts, RELEASES_REPO). GitHub redirects the old name to the new one, but copies
// up to 0.4.0 only accept a redirect to a release page, so they cannot update to 0.4.1 or later.
//
// What keeps its first value whatever the app is called (src/shared/identity.ts, LEGACY) is not
// here: the .deb package name `fartcrobat`, the NSIS
// GUID, the settings file name. The userData folder is the one of the version that first ran: an
// install keeps it across the rename.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The first version called Inkmoor. */
export const FIRST_INKMOOR = '0.4.0'

/** The first version that asks normiecore/Inkmoor for updates (before: normiecore/Fartcrobat). */
export const FIRST_INKMOOR_REPO = '0.4.1'

/** The .deb package name, the same under both names (dpkg upgrades in place only under one name). */
export const DEB_PACKAGE = 'fartcrobat'

/** Every name a release has had, for searches that must find an install under either. */
export const ALL_NAMES = ['Fartcrobat', 'Inkmoor']

const parse = (version) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) throw new Error(`not a version: ${version}`)
  return m.slice(1, 4).map(Number)
}

/** a < b, by major.minor.patch (a pre-release counts as its version). */
export function versionBefore(a, b) {
  const [x, y] = [parse(a), parse(b)]
  const i = [0, 1, 2].find((n) => x[n] !== y[n])
  return i !== undefined && x[i] < y[i]
}

/** The product name a version shipped (or ships) under. */
export const productName = (version) => (versionBefore(version, FIRST_INKMOOR) ? 'Fartcrobat' : 'Inkmoor')

/** The GitHub repository (owner/name) a version asks for updates and is published in. */
export const releaseRepo = (version) =>
  versionBefore(version.replace(/^v/, ''), FIRST_INKMOOR_REPO) ? 'normiecore/Fartcrobat' : 'normiecore/Inkmoor'

/** The names one version of the app has: its files, executables, policy locations and window global. */
export function productFor(version) {
  const v = version.replace(/^v/, '')
  const name = productName(v)
  const lower = name.toLowerCase()
  return {
    version: v,
    name,
    /** The renderer's test hook (window.__fartcrobat, window.__inkmoor). */
    windowGlobal: `__${lower}`,
    /** The prefix of its environment variables (FARTCROBAT_UPDATE_CHECKS, INKMOOR_UPDATE_CHECKS, ...). */
    envPrefix: name.toUpperCase(),
    /** The userData folder a first start of this version makes (one from an older name is kept). */
    userData: name,
    /** electron-updater's download cache under ~/.cache (from the package name). */
    updaterCache: `${lower}-updater`,
    winExe: `${name}.exe`,
    winSetupX64: `${name}-Setup-${v}-x64.exe`,
    winSetupArm64: `${name}-Setup-${v}-arm64.exe`,
    /** The installer for both processors that 0.2.0 also shipped. */
    winSetupCombined: `${name}-Setup-${v}.exe`,
    winPolicyKey: `HKLM\\SOFTWARE\\Policies\\${name}`,
    macDmgArm64: `${name}-${v}-arm64.dmg`,
    macApp: `${name}.app`,
    macExe: `/Applications/${name}.app/Contents/MacOS/${name}`,
    macPolicy: `/Library/Application Support/${name}/policy.json`,
    /** The .deb file; the package inside is always DEB_PACKAGE. */
    debFile: `${lower}_${v}_amd64.deb`,
    debDir: `/opt/${name}`,
    debExe: `/opt/${name}/${lower}`,
    /** electron-builder names the .deb's AppArmor profile after the executable (templates/linux/after-install.tpl). */
    debAppArmor: `/etc/apparmor.d/${lower}`,
    linuxPolicy: `/etc/${lower}/policy.json`,
    /** No version in the name: an update replaces the file in place and it keeps its name. */
    appImage: `${name}-x86_64.AppImage`,
    /** The GitHub repository it asks for updates (owner/name). */
    repo: releaseRepo(v)
  }
}

/** The product name a build of this checkout gets (package.json productName). */
export function checkoutName() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).productName
}

/** The version to rehearse to from `old` when none is given (see the top of this file). */
export function defaultNew(old, name = checkoutName()) {
  const [a, b, c] = parse(old)
  const next = `${a}.${b}.${c + 1}`
  return productName(next) !== name && name === 'Inkmoor' ? FIRST_INKMOOR : next
}

function main(argv) {
  const [first, second] = argv
  if (first === 'default-new' && second) return console.log(defaultNew(second))
  if (first === 'check-build' && second) {
    const built = checkoutName()
    if (built === productName(second)) return
    console.error(
      `This checkout builds ${built}, but ${second} is a ${productName(second)} version (Inkmoor from ${FIRST_INKMOOR} on): ` +
        `rehearse with a new version under the name this checkout builds.`
    )
    process.exit(1)
  }
  if (first === 'same-repo' && second && argv[2]) {
    if (releaseRepo(second) === releaseRepo(argv[2])) return
    console.error(
      `${second} asks ${releaseRepo(second)} for updates and ${argv[2]} is published in ${releaseRepo(argv[2])}: ` +
        `${second} cannot find it (names.mjs, FIRST_INKMOOR_REPO), so there is nothing to rehearse.`
    )
    process.exit(1)
  }
  if (first && second && !['default-new', 'check-build', 'same-repo'].includes(first)) {
    const names = productFor(first)
    if (!(second in names)) {
      console.error(`no field ${second}; one of: ${Object.keys(names).join(', ')}`)
      process.exit(2)
    }
    return console.log(names[second])
  }
  console.error('usage: names.mjs <version> <field> | default-new <old> | check-build <new> | same-repo <old> <new>')
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
