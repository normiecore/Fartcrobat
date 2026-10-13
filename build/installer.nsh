; Registers Fartcrobat with Windows "Default apps" so that Settings can list it for .pdf and the
; app's "Make default" button can open its page (ms-settings:defaultapps?registeredAppUser=Fartcrobat).
; The ProgId "Fartcrobat.Document" is created by electron-builder from win.fileAssociations.

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
