; StykAnimate's additions to Tauri's NSIS installer (docs/tauri/updater-migration.md).
;
; 1. An Electron copy of StykAnimate (installed by electron-builder, before 2.0) is removed first, silently, so the
;    two never sit side by side with two Start menu entries and competing file associations. Its uninstaller keeps
;    the user's data: settings, recovery, the project list and the library live in %APPDATA%\StykAnimate and
;    Documents\StykAnimate, which this app reads where they are. It runs before this installer writes its own file
;    associations and shortcuts, because it removes the Electron copy's ones (the same ProgIDs).
; 2. The library folder is created in the current user's real Documents folder, including redirected and OneDrive
;    paths. Library contents belong to the user and are deliberately kept on uninstall.
; 3. When the Electron updater runs this installer (it passes --updated /S --force-run), the app is started again
;    afterwards, as the Electron installer did.

; electron-builder's key for appId app.stykanimate.desktop: UUID v5 of the appId in its namespace
; 50e065bc-3134-11e6-9bab-38c9862bdaf3.
!define STYK_ELECTRON_GUID "fe40c1cb-7216-5497-9775-a306daabe735"

!macro STYK_REMOVE_ELECTRON_COPY ROOT
  ClearErrors
  ReadRegStr $R0 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${STYK_ELECTRON_GUID}" "UninstallString"
  ReadRegStr $R1 ${ROOT} "Software\${STYK_ELECTRON_GUID}" "InstallLocation"
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
  ${AndIf} ${FileExists} "$R1\Uninstall StykAnimate.exe"
    DetailPrint "Removing the previous StykAnimate (Electron) from $R1"
    ; _?= runs the uninstaller in place and waits for it. Its data stays: electron-builder keeps app data unless
    ; told otherwise, and /S never asks.
    ${If} "${ROOT}" == "HKLM"
      ExecWait '"$R1\Uninstall StykAnimate.exe" /S /allusers _?=$R1' $R2
    ${Else}
      ExecWait '"$R1\Uninstall StykAnimate.exe" /S /currentuser _?=$R1' $R2
    ${EndIf}
    DetailPrint "The previous StykAnimate's uninstaller finished ($R2)"
    Delete "$R1\Uninstall StykAnimate.exe"
    RMDir "$R1"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; STYK_KEEP_ELECTRON=1 keeps an Electron copy (testing the installer beside it).
  ReadEnvStr $R3 "STYK_KEEP_ELECTRON"
  ${If} $R3 != "1"
    !insertmacro STYK_REMOVE_ELECTRON_COPY HKCU
    !insertmacro STYK_REMOVE_ELECTRON_COPY HKLM
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  CreateDirectory "$DOCUMENTS\StykAnimate\library"
  ; Started by the Electron updater: open the app again, as its installer did.
  ${GetOptions} $CMDLINE "--force-run" $R4
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The stykanimate:// handler the app registered for this user on its first start.
  ReadRegStr $R5 HKCU "Software\Classes\stykanimate\shell\open\command" ""
  StrCpy $R6 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ${If} $R5 == $R6
    DeleteRegKey HKCU "Software\Classes\stykanimate"
  ${EndIf}
!macroend
