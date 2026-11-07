; A stand-in for the Electron app's electron-builder Setup, for the upgrade proof. It writes the layout electron-builder's
; NSIS installer writes (read from app-builder-lib's templates: installSection.nsh, installUtil.nsh, FileAssociation.nsh,
; uninstaller.nsh) and nothing else, and ONLY into a sandbox: every registry key goes under
; HKCU\Software\StykAnimateSandbox\<SANDBOX>\, and shortcuts and the library under SANDBOX_DIR.
;
; The real Setup cannot be run for this proof: it writes the user's file associations and uninstall entry in the real
; registry, and this machine's owner has theirs.
;
; Defines: VERSION, SOURCE_DIR (the fixture "Electron app" files), OUTFILE, SANDBOX, SANDBOX_DIR.

Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent

!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define APP_GUID "da89159e-9653-5b0d-96ae-4aeef8dc5497"
!define REG "Software\StykAnimateSandbox\${SANDBOX}\"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
!define INSTALL_KEY "Software\${APP_GUID}"

Name "StykAnimate"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\StykAnimate"

!macro associate EXT NAME
  WriteRegStr HKCU "${REG}Software\Classes\.${EXT}" "" "${NAME}"
  WriteRegNone HKCU "${REG}Software\Classes\.${EXT}\OpenWithProgids" "${NAME}"
  WriteRegStr HKCU "${REG}Software\Classes\${NAME}" "" "${NAME}"
  WriteRegStr HKCU "${REG}Software\Classes\${NAME}\DefaultIcon" "" '"$INSTDIR\StykAnimate.exe,0"'
  WriteRegStr HKCU "${REG}Software\Classes\${NAME}\shell" "" "open"
  WriteRegStr HKCU "${REG}Software\Classes\${NAME}\shell\open" "" "Open with StykAnimate"
  WriteRegStr HKCU "${REG}Software\Classes\${NAME}\shell\open\command" "" '"$INSTDIR\StykAnimate.exe" "%1"'
!macroend

Function .onInit
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  ${GetParameters} $R0
FunctionEnd

Function un.onInit
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath $INSTDIR
  File /r "${SOURCE_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall StykAnimate.exe"
  WriteRegStr HKCU "${REG}${INSTALL_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr HKCU "${REG}${INSTALL_KEY}" KeepShortcuts "true"
  WriteRegStr HKCU "${REG}${INSTALL_KEY}" ShortcutName "StykAnimate"
  WriteRegStr HKCU "${REG}${UNINSTALL_KEY}" DisplayName "StykAnimate ${VERSION}"
  WriteRegStr HKCU "${REG}${UNINSTALL_KEY}" UninstallString '"$INSTDIR\Uninstall StykAnimate.exe" /currentuser'
  WriteRegStr HKCU "${REG}${UNINSTALL_KEY}" QuietUninstallString '"$INSTDIR\Uninstall StykAnimate.exe" /currentuser /S'
  WriteRegStr HKCU "${REG}${UNINSTALL_KEY}" DisplayVersion "${VERSION}"
  WriteRegStr HKCU "${REG}${UNINSTALL_KEY}" DisplayIcon "$INSTDIR\StykAnimate.exe,0"
  !insertmacro associate "nodes" "Stick Nodes figure"
  !insertmacro associate "nodemc" "Stick Nodes movie clip"
  !insertmacro associate "stknds" "Stick Nodes project"
  !insertmacro associate "piv" "Pivot animation"
  !insertmacro associate "stk" "Pivot stick figure"
  !insertmacro associate "stykmov" "StykAnimate movieclip"
  !insertmacro associate "stkz" "StykAnimate figure"
  !insertmacro associate "styk" "StykAnimate project"
  ; The link, as the Electron app registers it at run time (setAsDefaultProtocolClient).
  WriteRegStr HKCU "${REG}Software\Classes\stykanimate" "" "URL:stykanimate"
  WriteRegStr HKCU "${REG}Software\Classes\stykanimate" "URL Protocol" ""
  WriteRegStr HKCU "${REG}Software\Classes\stykanimate\shell\open\command" "" `"$INSTDIR\StykAnimate.exe" "%1"`
  CreateDirectory "${SANDBOX_DIR}\StartMenu"
  CreateDirectory "${SANDBOX_DIR}\Desktop"
  CreateShortCut "${SANDBOX_DIR}\StartMenu\StykAnimate.lnk" "$INSTDIR\StykAnimate.exe"
  CreateShortCut "${SANDBOX_DIR}\Desktop\StykAnimate.lnk" "$INSTDIR\StykAnimate.exe"
  CreateDirectory "${SANDBOX_DIR}\Documents\StykAnimate\library"
SectionEnd

!macro unassociate EXT NAME
  DeleteRegValue HKCU "${REG}Software\Classes\.${EXT}\OpenWithProgids" "${NAME}"
  DeleteRegKey HKCU "${REG}Software\Classes\${NAME}"
!macroend

Section "Uninstall"
  !insertmacro unassociate "nodes" "Stick Nodes figure"
  !insertmacro unassociate "nodemc" "Stick Nodes movie clip"
  !insertmacro unassociate "stknds" "Stick Nodes project"
  !insertmacro unassociate "piv" "Pivot animation"
  !insertmacro unassociate "stk" "Pivot stick figure"
  !insertmacro unassociate "stykmov" "StykAnimate movieclip"
  !insertmacro unassociate "stkz" "StykAnimate figure"
  !insertmacro unassociate "styk" "StykAnimate project"
  DeleteRegKey HKCU "${REG}${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${REG}${INSTALL_KEY}"
  Delete "${SANDBOX_DIR}\StartMenu\StykAnimate.lnk"
  Delete "${SANDBOX_DIR}\Desktop\StykAnimate.lnk"
  Delete "$INSTDIR\Uninstall StykAnimate.exe"
  RMDir /r "$INSTDIR"
SectionEnd
