; Registers Fartcrobat with Windows "Default apps" so that Settings can list it for .pdf and the
; app's "Make default" button can open its page (ms-settings:defaultapps?registeredAppUser=Fartcrobat).
; The ProgId "Fartcrobat.Document" is created by electron-builder from win.fileAssociations.
;
; customInit: each processor has its own installer (electron-builder.yml), and the arm64 one would
; otherwise run on an x64 PC, unpack nothing and leave shortcuts to a missing Fartcrobat.exe (after
; removing a working install). It stops first and says which file to download (a silent install
; exits with code 1).

!macro customInit
  !ifdef APP_ARM64
    !ifndef APP_64
      ${IfNot} ${IsNativeARM64}
        MessageBox MB_OK|MB_ICONSTOP "This installer is for Windows on Arm. For this PC, download Fartcrobat-Setup-${VERSION}-x64.exe from https://github.com/normiecore/Fartcrobat/releases/latest" /SD IDOK
        SetErrorLevel 1
        Quit
      ${EndIf}
    !endif
  !endif
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Fartcrobat\Capabilities" "ApplicationName" "Fartcrobat"
  WriteRegStr SHELL_CONTEXT "Software\Fartcrobat\Capabilities" "ApplicationDescription" "Read, edit, comment on and sign PDF documents."
  WriteRegStr SHELL_CONTEXT "Software\Fartcrobat\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Fartcrobat\Capabilities\FileAssociations" ".pdf" "Fartcrobat.Document"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Fartcrobat" "Software\Fartcrobat\Capabilities"
  ; Let Explorer pick up the new association.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Fartcrobat"
  DeleteRegKey SHELL_CONTEXT "Software\Fartcrobat\Capabilities"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Fartcrobat"
!macroend
