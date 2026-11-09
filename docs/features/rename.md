# Feature: rename (Fartcrobat becomes Inkmoor in 0.4.0)

The app was called Fartcrobat up to 0.3 and is called Inkmoor from 0.4.0 (owner's choice, 3 Nov
2026, from a screened shortlist). Releases 0.2.0 to 0.3.0 shipped the in-app updater, so installed
copies update straight into the renamed build. That only works if the ids those copies, the files
they saved and administrators' setups depend on stay as they are. `src/shared/identity.ts` holds
the product name (`PRODUCT_NAME`) and those ids (`LEGACY`); it explains each one. NEWNAME below
means Inkmoor.

## Rules for later changes

- Never change anything in `LEGACY`, never rename the GitHub repository again (see "The repository
  rename" below), never create a new repository called `Fartcrobat` under `normiecore` (it would end
  GitHub's redirect from the old name), and keep writing the PDF
  keys (`/FartcrobatData` and its `fartcrobat` entry, `/FartcrobatMark`, `/FartcrobatOCR`, ...),
  the XFDF `<fartcrobat-data>` element, the `fartcrobat-form-data` format, the settings file name
  `fartcrobat-settings.json` and the saved-password key domain as they are.
- Test fixtures were generated under the old name (text such as "Hello Fartcrobat page 1",
  "Fartcrobat Tests", certificate names "Fartcrobat Test CA"); tests that read them keep those
  strings.

## The repository rename (0.4.1)

The analysis below says the repository could not be renamed without stranding installed copies,
and that held: copies up to 0.4.0 ask `github.com/normiecore/Fartcrobat/releases/latest`, GitHub
answers with a 301 to `/normiecore/Inkmoor/releases/latest`, and `parseReleaseLocation` rejects
that (it is not a release page under the old name), so they show "GitHub sent an answer Inkmoor
doesn't understand" and never find another update. On 9 Nov 2026 the owner renamed it to
`normiecore/Inkmoor` anyway: the testers had 0.1.0, which has no updater, and install 0.4.1 by hand.

- From 0.4.1 the app asks `normiecore/Inkmoor` (`RELEASES_REPO` in `src/shared/identity.ts`, the
  `publish` block of `electron-builder.yml`). People on 0.2.0 to 0.4.0 install the next version by
  hand once (`docs/releases/v0.4.1.md`, README).
- The update rehearsal cannot update a version up to 0.4.0 to 0.4.1 or later. It notes that and
  skips (`same-repo` in `tests/update-rehearsal/names.mjs`); from 0.4.1 to 0.4.2 it runs again.
- Releases, tags, issues and git remotes keep working under the old URL through GitHub's redirect.

## Status

- Done: the legacy ids are pinned (`nsis.guid`, `deb.packageName` in electron-builder.yml, the
  `.mcpb` manifest name, the MCP server name, the ChatGPT config table) and the migration
  plumbing is in place: the userData folder from before the rename is kept (`pinUserData` in
  src/main/index.ts, `defaultUserDataDir` in the MCP helper), machine policies are read from both
  locations, the helper finds the app under either name, the old updater's download cache is
  removed at the first start, desktop entries written under the old name are rewritten at start,
  stale temp folders of either prefix are swept, and the Windows installer removes the old
  "Default apps" registration. `tests/engine/rename-identity.test.ts` covers it.
- Done: the rename itself (UI, installers, artifact names, environment variables, docs) and the
  release notes (`docs/releases/v0.4.0.md`). The update rehearsal knows both names.
- Known gaps, accepted and told in the release notes: an extension installed from 0.3 runs the
  0.3 helper, which only knows Fartcrobat.exe and /opt/Fartcrobat; until Inkmoor has started once
  (which rewrites agent-access/app.json) it cannot start the app after a Windows "Later" install or
  a .deb upgrade. Windows shortcuts are deleted and recreated rather than renamed (electron-builder
  keeps them only when the executable name is unchanged). A Windows "Open with" choice of
  Fartcrobat.exe stops working (the file is gone), so it no longer counts as the default and the
  app offers Make default. The .deb command becomes `inkmoor`.
- The interactive Windows installer keeps an install folder ending in `\Fartcrobat`
  (customPageAfterChangeDir in build/installer.nsh); electron-builder would otherwise append
  `\Inkmoor`. Not compiled here (needs wine); the release and update-rehearsal workflows build it.
- Not done: the macOS card offering to move the old Fartcrobat.app to the Bin (the release notes
  tell people instead), and a notice when remembered passwords could not be read after the rename
  on macOS or Linux (they are skipped silently, as before; the release notes mention it).
- Before publishing 0.4.0: run the update rehearsal from 0.3.0 on every platform (see Test changes
  and Order of PRs below); check whether a remembered password survives on macOS and Linux.

The analysis this plan came from (14 Oct to 3 Nov 2026 sessions) follows.

## Verification of the key claims

**Confirmed: the GitHub repo cannot be renamed** (without stranding installed copies; it was renamed
for 0.4.1 anyway, see "The repository rename").
- `latestRelease` requests `<base>/releases/latest` without following redirects. It accepts only a 3xx whose Location stays under the same origin and the `/normiecore/Fartcrobat/` prefix (case-insensitive) and ends in `/releases/tag/v<semver>`. See `src/features/updates/main/release.ts:8`, `:37-66` and `:84-99`. The base is `src/shared/updates.ts:11`.
- After a rename, a 301 to `/normiecore/NEWNAME/...` fails the prefix check, so 0.2 and 0.3 installs would show `CHECK_UNEXPECTED` forever.
- `releasePageAllowed` (`release.ts:105-129`) is tied to the same base.
- electron-updater only runs afterwards (`electronUpdater.ts:81`), using 0.3.0's built-in `app-update.yml` (owner normiecore, repo Fartcrobat).

**Confirmed: the NSIS GUID comes from the appId.**
- The code is `guid = options.guid || UUID.v5(appInfo.id, 50e065bc-…)` (app-builder-lib 26.15.3 `out/targets/nsis/NsisTarget.js:28,157`).
- I recomputed UUIDv5(`org.fartcrobat.app`) = `bd977413-7ee9-5f76-80a8-7e980aa59bd1`. That matches `src/agent-shim/launch.ts:29`.
- `INSTALL_REGISTRY_KEY` and `UNINSTALL_REGISTRY_KEY` are built from it (`templates/nsis/multiUser.nsh:8-9`), and per-user and per-machine detection reads InstallLocation from them (`:26`, `:75`).
- So if the appId changes without pinning the GUID, the new build installs side by side. Pinning `nsis.guid` prevents this.

**Confirmed: AppImage and Windows installs update in place.**
- AppImage overwrites in place when the existing file name has no version (electron-updater 6.8.10 `AppImageUpdater.js:83-91`). `Fartcrobat-x86_64.AppImage` has none (`electron-builder.yml:123`).
- The Windows silent install uses `--updated /S` (`NsisUpdater.js:107-121`).

**Correction: the Linux desktop file name comes from `package.json` `desktopName`, not `executableName`.**
- Because `syncDesktopName: true` is set (`electron-builder.yml:105`), the name is taken from `desktopName` (`LinuxTargetHelper.js:203-218`).
- So `executableName` can change as long as `"desktopName": "fartcrobat.desktop"` stays.
- electron-builder would default `StartupWMClass` to the `desktopName` base, but `electron-builder.yml:116` overrides it.
- `deb.packageName` exists in the scheme and is used at `FpmTarget.js:99`.

**Not verifiable here: safeStorage naming (no Electron source or binary in this environment).**
- Passwords use the async API (`encryptStringAsync`, `src/main/passwords/electronCipher.ts:46`). It is the only safeStorage user (`grep encryptString`).
- On macOS ("<name> Safe Storage" Keychain item) and Linux (libsecret or kwallet application name), the key follows `app.name`. Exactly when Electron 44's async encryptor reads the name is unknown, so a "keep the old name until ready" trick cannot be relied on.
- On Windows, DPAPI with `<userData>/Local State` keeps working if userData stays put.
- Losing these secrets costs only remembered passwords, including Digital ID passwords. Failed records are already skipped (`src/main/passwords/store.ts:179-206`).

**The app name is visible in the UI, so `app.setName` must change.**
- `src/main/menu.ts:9` passes `app.name`.
- The macOS `about`, `hide` and `quit` roles derive their labels from it (`src/main/util/menuTemplate.ts:72-82`).

## What changes and what stays

**Stays as hidden legacy ids, permanently.** Comment each one in a new `src/shared/legacyIds.ts`:

| Id | Where |
|---|---|
| GitHub repo `normiecore/Fartcrobat` (renamed to `normiecore/Inkmoor` for 0.4.1 after all); never rename or delete the `normiecore` account | `electron-builder.yml:32-35`, `src/shared/updates.ts:11` |
| appId `org.fartcrobat.app` and AUMID | `electron-builder.yml:2`, `src/main/index.ts:39` |
| New: `nsis.guid: bd977413-7ee9-5f76-80a8-7e980aa59bd1` | `electron-builder.yml`, so a later appId change cannot break silent upgrades |
| Windows ProgId `Fartcrobat.Document` | `electron-builder.yml:43`, `src/main/util/systemDefaults.ts:33` |
| New: `deb.packageName: fartcrobat` | `electron-builder.yml:124`; package.json `"name"` changes |
| `"desktopName": "fartcrobat.desktop"` and `DESKTOP_FILE` | `package.json:84`, `src/main/util/linuxDesktop.ts:6` |
| `.mcpb` manifest `name: 'fartcrobat'` | `scripts/build-agent-extension.mjs:34` |
| Password hash domain `fartcrobat/saved-password/v1` | `src/main/passwords/keys.ts:26` |
| Every key written into PDFs: `/FartcrobatData` and the inner `fartcrobat` value, `FartcrobatMark/Settings/Wrap/Behind/XObjects/…`, `FartcrobatFont/ToUnicode/HeldRedact`, `FartcrobatOCR`, `FartcrobatMeasure/AP` | write them unchanged; they are file-format ids, and adding new ones gains nothing |
| XFDF `<fartcrobat-data>` and `format: 'fartcrobat-form-data'` | `comments/xfdf.ts:138-140,314`, `forms-fill/formData.ts:209` |

**Changes, with migration code:**
- userData folder
- policy locations
- `FARTCROBAT_USER_DATA` (the new name plus an alias)
- Linux generated desktop entry contents and the `X-…-Generated` marker
- temp-file prefix
- Windows exe name and `RegisteredApplications` name
- `package.json` name together with `appVersion.ts:13`

**Changes freely:**
- `productName`, `shortcutName`, window titles (`src/main/windows.ts:372,403`, `src/renderer/index.html:5`, `src/renderer/src/main.tsx:73`)
- dmg title, Info.plist copyright, desktop `Name` and `StartupWMClass`, deb `maintainer`
- artifact names (keep `${arch}`)
- the `.mcpb` `display_name` and descriptions, MCP serverInfo `title` (`src/agent-shim/index.ts:25`), shim log prefix
- tool descriptions and `SERVER_INSTRUCTIONS`
- all UI and toast prose
- pipe and socket prefix (`endpoint.ts:38-39`), `app://` host (`src/main/protocol.ts:7`; no localStorage or IndexedDB depends on it), renderer event names, `window.__fartcrobat`, the `Symbol.for` name, the drag MIME type
- `Creator` and `Producer` metadata, the signature `/Prop_Build /App /Name` (`sign.ts:197`), the print job title
- the keyring probe string (`electronCipher.ts:46`)
- test-only env vars (rename them with no alias)

## First-start migration code

1. **userData pin.** New file `src/main/identity.ts`, called at `src/main/index.ts:36-37` before anything else.
   - Call `app.setName(NEWNAME)`.
   - If `NEWNAME_USER_DATA ?? FARTCROBAT_USER_DATA` is set, use it.
   - Otherwise, if `<appData>/Fartcrobat` exists and `<appData>/NEWNAME` does not, call `app.setPath('userData', <appData>/Fartcrobat)`.
   - Never move the folder.
   - This keeps settings (`store.ts:20`), recent files, `digital-ids/`, `tessdata/`, `agent-access/{endpoint,app}.json`, the audit log, `agent-helper/shim.mjs` (the path in ChatGPT configs users already pasted) and Windows DPAPI secrets.
   - It also keeps old and new apps on one single-instance lock.

2. **Shim mirror.** In `src/agent-shim/launch.ts:120-131` (`defaultUserDataDir`), apply the same legacy-folder rule. `separateProfile` (`:137-148`) must compare against the resolved folder, or a ChatGPT config naming the old folder counts as a separate profile.
   - `src/agent-shim/app.ts:78-85`: read `NEWNAME_USER_DATA ?? FARTCROBAT_USER_DATA`.
   - `launch.ts:29-31`, `:81-108`: list both `NEWNAME.exe` and `Fartcrobat.exe`, both `/Applications/{NEWNAME,Fartcrobat}.app`, and both `/opt/{NEWNAME,Fartcrobat}/...`. The GUID key is unchanged.
   - 0.3.x extensions already installed keep working: the folder is unchanged and `app.json` is rewritten with the new exe on every start.

3. **Secrets on macOS and Linux.**
   - Gate the change on a rehearsal test (see the test changes below). If that test shows secrets are lost, flag the records that fail to decrypt after the rename. Then show a one-time notice: "Passwords remembered by Fartcrobat need to be entered once more." Add a hook in `src/main/passwords/store.ts` next to the skip logic at `:179-206`, with a `kv` flag in settings.
   - Windows needs nothing.
   - A child-process re-encrypt (`--migrate-secrets`, `app.setName('Fartcrobat')`, temporary userData, plaintext over stdio) is possible, but leave it out of 0.4.0.

4. **Machine policy.** In `src/main/policy.ts:37-41` and `:85`, read the new paths (`/Library/Application Support/NEWNAME/policy.json`, `/etc/<newname>/policy.json`, `HKLM\SOFTWARE\Policies\NEWNAME`) and the old ones.
   - Per setting, the new location wins and the old one is the fallback.
   - Without this, `AgentAccess=0` and `RememberPasswords=0` deployments silently stop applying.

5. **Windows.**
   - Rename the exe (`win.executableName` defaults to `productName`).
   - `isFartcrobatProgId` (now `isInkmoorProgId`) does NOT accept `applications\fartcrobat.exe`: the
     update removes that file, so such a choice is broken and the app must offer Make default (review
     of 3 Nov 2026 corrected this).
   - `build/installer.nsh:14,23-27,33-35`: new name in `RegisteredApplications` and `Capabilities`. The old uninstaller deletes the old keys during the `--updated` run.
   - Keep `Fartcrobat.Document` in `FileAssociations`.
   - `src/main/defaultApp.ts:135` `registeredAppUser=NEWNAME`.

6. **Linux.**
   - In `linuxDesktop.ts:8`, recognise both `X-Fartcrobat-Generated=true` and the new marker.
   - On start, rewrite an existing generated `fartcrobat.desktop` with the new `Name` (`:56`), `StartupWMClass` (`:65`) and icon (`defaultApp.ts:39-41`). Keep the file id.
   - `tempFiles.ts:103`: the cleanup regex accepts both prefixes.

7. **macOS.** On first start, if `/Applications/Fartcrobat.app` (or `~/Applications/Fartcrobat.app`) exists with a lower version, show a one-time card: "Fartcrobat is now NEWNAME. Move the old app to the Trash?" The button calls `shell.trashItem`, and only when the person clicks it.

8. **ChatGPT TOML.** At `src/features/agent-access/main.ts:219`, keep the table key `[mcp_servers.fartcrobat]` so pasting replaces the existing entry. Write `NEWNAME_USER_DATA` in the env table.
   - Leave `COMPANION_SHIM_VERSION` (`protocol.ts:26`) alone. Old extensions work, and a reinstall only refreshes their display name.

## What to tell people (release notes, the README and the update card text)

- **Everyone:** the app is now NEWNAME. Settings, recent files and Digital IDs carry over.
- **macOS and Linux:** remembered passwords need entering once more, unless the rehearsal proves otherwise.
- **Windows:** taskbar and Start pins for `Fartcrobat.exe` break. Pin NEWNAME again. The install folder keeps its old name on updated machines.
- **macOS:** drag NEWNAME into Applications and delete Fartcrobat.app.
- **.deb:** `apt install ./newname_0.4.0_amd64.deb` upgrades in place (same package name).
- **Claude Desktop:** the existing extension keeps working. Reinstall it from Preferences > AI apps to see the new name.
- **Admins:**
  - New policy locations (Windows `HKLM\SOFTWARE\Policies\NEWNAME`, `/etc/<newname>/policy.json` on Linux, `/Library/Application Support/NEWNAME/policy.json` on macOS).
  - The old locations are still read (deprecated in 0.4, kept at least a year). Where both set the same value, the new location wins.
  - The `.deb` package name stays `fartcrobat`.

## Test changes

- **Unit tests:**
  - userData resolver: legacy folder present or absent, env alias.
  - Shim `defaultUserDataDir` and `separateProfile` with the legacy folder (`tests/engine/agent-shim.test.ts`).
  - Policy: both locations, new wins (`src/features/agent-access/main/policy.test.ts`, core policy tests).
  - `isFartcrobatProgId` with the legacy exe.
  - Linux desktop rewrite with the old marker.
  - Temp-file cleanup regex.
  - `appVersion`.
  - Install candidates for both names.
  - Release-check tests unchanged; add one asserting a cross-repo 301 is still rejected.
- **Mechanical:** `window.__fartcrobat` and env var renames across `tests/e2e/**`, `tests/e2e/helpers.ts` and `agent-helpers.ts`. Keep the fixtures unchanged: they double as files written by the old app.
- **New fixture test:** open a 0.3-written PDF (watermark, OCR layer, measure scale, pending redaction) and assert it is recognised. Save and reopen, and assert the keys are still the old ones.
- **Update rehearsal** (`.github/workflows/update-rehearsal.yml`, `tests/update-rehearsal/*`): install the published 0.3.0 (old names), update to the 0.4.0 candidate, then assert:
  - Windows, per user and per machine: exactly one uninstall entry, the same InstallLocation, settings kept, a saved password unlocks, and the `.pdf` default is still set.
  - AppImage: the same file is replaced, `~/.config/Fartcrobat` is still used, and the generated desktop entry is rewritten.
  - .deb: `dpkg -l` shows one package.
  - Policy: an old-location `AutoUpdate` or `AgentAccess` value still applies.
  - macOS and Linux: whether a saved password survives. This decides the notice in step 3.
  - The `release-downloads.mjs` file-name table and the `release.yml:143,261,265` names.

## Order of PRs

1. **Legacy-id pins** (no visible change): `nsis.guid`, `deb.packageName`, a comment on `desktopName`, `src/shared/legacyIds.ts`, and a CLAUDE.md "do not rename" list.
2. **Migration plumbing**, with `PRODUCT_NAME` still `Fartcrobat`, so it is a no-op that tests drive with a fake new name: steps 1 to 8 and their unit tests.
3. **The rename itself:** `productName`, `package.json` name and `appVersion`, build config, artifact names, the installer `.nsh`, UI prose, agent display strings, env vars, `window.__fartcrobat`, `release-downloads.mjs`, and workflows (the rehearsal knows both names).
4. **Docs:** README, `docs/features/*`, the CLAUDE.md policy table, and the draft release notes and admin notice.
5. **Release:** bump to 0.4.0 (PR), run the Release workflow as a draft, run the update rehearsal from 0.3.0, then publish. Publish only after the rehearsal passes on Windows (both install modes) and on the AppImage.

Scratch inputs: `/tmp/claude-0/rename/all.txt`, `/tmp/claude-0/rename/pkgs/app-builder-lib-26.15.3/package`, `/tmp/claude-0/rename/pkgs/electron-updater-6.8.10/package`. No repo files were edited.
