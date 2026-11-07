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
; MACHINE: the install of "all users", whose keys the Setup's sandbox build keeps under <prefix>HKLM\.
!ifdef MACHINE
  !define PFX "${REG}HKLM\"
  !define SCOPE "/allusers"
!else
  !define PFX "${REG}"
  !define SCOPE "/currentuser"
!endif
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
!define INSTALL_KEY "Software\${APP_GUID}"

Name "StykAnimate"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\StykAnimate"

!macro associate EXT NAME
  WriteRegStr HKCU "${PFX}Software\Classes\.${EXT}" "" "${NAME}"
  WriteRegNone HKCU "${PFX}Software\Classes\.${EXT}\OpenWithProgids" "${NAME}"
  WriteRegStr HKCU "${PFX}Software\Classes\${NAME}" "" "${NAME}"
  WriteRegStr HKCU "${PFX}Software\Classes\${NAME}\DefaultIcon" "" '"$INSTDIR\StykAnimate.exe,0"'
  WriteRegStr HKCU "${PFX}Software\Classes\${NAME}\shell" "" "open"
  WriteRegStr HKCU "${PFX}Software\Classes\${NAME}\shell\open" "" "Open with StykAnimate"
  WriteRegStr HKCU "${PFX}Software\Classes\${NAME}\shell\open\command" "" '"$INSTDIR\StykAnimate.exe" "%1"'
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
  WriteRegStr HKCU "${PFX}${INSTALL_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr HKCU "${PFX}${INSTALL_KEY}" KeepShortcuts "true"
  WriteRegStr HKCU "${PFX}${INSTALL_KEY}" ShortcutName "StykAnimate"
  WriteRegStr HKCU "${PFX}${UNINSTALL_KEY}" DisplayName "StykAnimate ${VERSION}"
  WriteRegStr HKCU "${PFX}${UNINSTALL_KEY}" UninstallString '"$INSTDIR\Uninstall StykAnimate.exe" ${SCOPE}'
  WriteRegStr HKCU "${PFX}${UNINSTALL_KEY}" QuietUninstallString '"$INSTDIR\Uninstall StykAnimate.exe" ${SCOPE} /S'
  WriteRegStr HKCU "${PFX}${UNINSTALL_KEY}" DisplayVersion "${VERSION}"
  WriteRegStr HKCU "${PFX}${UNINSTALL_KEY}" DisplayIcon "$INSTDIR\StykAnimate.exe,0"
  !insertmacro associate "nodes" "Stick Nodes figure"
  !insertmacro associate "nodemc" "Stick Nodes movie clip"
  !insertmacro associate "stknds" "Stick Nodes project"
  !insertmacro associate "piv" "Pivot animation"
  !insertmacro associate "stk" "Pivot stick figure"
  !insertmacro associate "stykmov" "StykAnimate movieclip"
  !insertmacro associate "stkz" "StykAnimate figure"
  !insertmacro associate "styk" "StykAnimate project"
  ; The link, as the Electron app registers it at run time (setAsDefaultProtocolClient).
  WriteRegStr HKCU "${PFX}Software\Classes\stykanimate" "" "URL:stykanimate"
  WriteRegStr HKCU "${PFX}Software\Classes\stykanimate" "URL Protocol" ""
  WriteRegStr HKCU "${PFX}Software\Classes\stykanimate\shell\open\command" "" `"$INSTDIR\StykAnimate.exe" "%1"`
  CreateDirectory "${SANDBOX_DIR}\StartMenu"
  CreateDirectory "${SANDBOX_DIR}\Desktop"
  CreateShortCut "${SANDBOX_DIR}\StartMenu\StykAnimate.lnk" "$INSTDIR\StykAnimate.exe"
  CreateShortCut "${SANDBOX_DIR}\Desktop\StykAnimate.lnk" "$INSTDIR\StykAnimate.exe"
  CreateDirectory "${SANDBOX_DIR}\Documents\StykAnimate\library"
SectionEnd

!macro unassociate EXT NAME
  DeleteRegValue HKCU "${PFX}Software\Classes\.${EXT}\OpenWithProgids" "${NAME}"
  DeleteRegKey HKCU "${PFX}Software\Classes\${NAME}"
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
  DeleteRegKey HKCU "${PFX}${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${PFX}${INSTALL_KEY}"
  Delete "${SANDBOX_DIR}\StartMenu\StykAnimate.lnk"
  Delete "${SANDBOX_DIR}\Desktop\StykAnimate.lnk"
  Delete "$INSTDIR\Uninstall StykAnimate.exe"
  RMDir /r "$INSTDIR"
SectionEnd
