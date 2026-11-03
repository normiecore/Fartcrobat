; Registers Inkmoor with Windows "Default apps" so that Settings can list it for .pdf and the
; app's "Make default" button can open its page (ms-settings:defaultapps?registeredAppUser=Inkmoor).
; The ProgId "Fartcrobat.Document" is created by electron-builder from win.fileAssociations.
;
; customInit: each processor has its own installer (electron-builder.yml), and the arm64 one would
; otherwise run on an x64 PC, unpack nothing and leave shortcuts to a missing Inkmoor.exe (after
; removing a working install). It stops first and says which file to download (a silent install
; exits with code 1).

!macro customInit
  !ifdef APP_ARM64
    !ifndef APP_64
      ${IfNot} ${IsNativeARM64}
        MessageBox MB_OK|MB_ICONSTOP "This installer is for Windows on Arm. For this PC, download Inkmoor-Setup-${VERSION}-x64.exe from https://github.com/normiecore/Fartcrobat/releases/latest" /SD IDOK
        SetErrorLevel 1
        Quit
      ${EndIf}
    !endif
  !endif
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Inkmoor\Capabilities" "ApplicationName" "Inkmoor"
  WriteRegStr SHELL_CONTEXT "Software\Inkmoor\Capabilities" "ApplicationDescription" "Read, edit, comment on and sign PDF documents."
  WriteRegStr SHELL_CONTEXT "Software\Inkmoor\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Inkmoor\Capabilities\FileAssociations" ".pdf" "Fartcrobat.Document"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Inkmoor" "Software\Inkmoor\Capabilities"
  ; Up to 0.3 the app registered under its old name, Fartcrobat (src/shared/identity.ts). An update
  ; replaces that registration; the ProgId above keeps its old name so default-app choices survive.
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Fartcrobat"
  DeleteRegKey SHELL_CONTEXT "Software\Fartcrobat\Capabilities"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Fartcrobat"
  ; Let Explorer pick up the new association.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Inkmoor"
  DeleteRegKey SHELL_CONTEXT "Software\Inkmoor\Capabilities"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Inkmoor"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Fartcrobat"
  DeleteRegKey SHELL_CONTEXT "Software\Fartcrobat\Capabilities"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Fartcrobat"
!macroend

; An install from before the rename (Fartcrobat, up to 0.3) lives in a folder named Fartcrobat. When
; this installer runs with its pages (not the silent in-app update), electron-builder appends
; \Inkmoor to any folder whose path does not contain "Inkmoor" (instFilesPre), which would put the
; app in ...\Fartcrobat\Inkmoor next to an empty old folder. This hook replaces that check for the
; files page: a folder ending in \Fartcrobat is kept as it is, any other gets electron-builder's.
!macro customPageAfterChangeDir
  !ifdef allowToChangeInstallationDirectory
    !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
      !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !endif
    !define MUI_PAGE_CUSTOMFUNCTION_PRE keepLegacyInstallDir
    Function keepLegacyInstallDir
      StrCpy $0 $INSTDIR "" -11
      ${If} $0 != "\Fartcrobat"
        Call instFilesPre
      ${EndIf}
    FunctionEnd
  !endif
!macroend
