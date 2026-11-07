; The StykAnimate Setup for Windows (docs/native/shell.md, "The installer: NSIS").
;
; It keeps the upgrade path of the Electron installer: the same uninstall key (the v5 UUID electron-builder derives from
; app.stykanimate.desktop), the same install-location key, the same file-association ProgIDs, the same shortcut names and
; the same arguments an installed copy's updater passes (--updated /S --force-run /D=<dir>). An existing install is
; removed with its own uninstaller first, silently, as electron-builder's installer does for its own upgrades.
;
; Defines (makensis /D...):
;   VERSION      the version being installed (required)
;   SOURCE_DIR   the folder whose contents are installed (required)
;   OUTFILE      the Setup to write (required)
;   ICON_FILE    the .ico of the Setup and the uninstaller (optional)
;   PLUGIN_DIR   a folder holding x86-unicode\WinShell.dll (shortcut application id); electron-builder's cache has one
;   SANDBOX      a test build: every registry key goes under HKCU\Software\StykAnimateSandbox\<SANDBOX>\, shortcuts and the
;                library go under SANDBOX_DIR, no process is waited for and Explorer is not notified; nothing outside
;                the sandbox is touched
;   SANDBOX_DIR  with SANDBOX: the folder standing in for the profile's Start menu, desktop and Documents

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

!ifndef VERSION
  !error "define VERSION"
!endif
!ifndef SOURCE_DIR
  !error "define SOURCE_DIR"
!endif
!ifndef OUTFILE
  !error "define OUTFILE"
!endif

!define PRODUCT_NAME "StykAnimate"
!define APP_EXE "StykAnimate.exe"
!define UNINSTALL_EXE "Uninstall StykAnimate.exe"
!define APP_ID "app.stykanimate.desktop"
!define APP_GUID "da89159e-9653-5b0d-96ae-4aeef8dc5497"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
!define INSTALL_KEY "Software\${APP_GUID}"

!ifdef SANDBOX
  !define REG "Software\StykAnimateSandbox\${SANDBOX}\"
!else
  !define REG ""
!endif

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "x64.nsh"

!ifdef PLUGIN_DIR
  !addplugindir /x86-unicode "${PLUGIN_DIR}\x86-unicode"
!else
  !ifndef SANDBOX
    !error "a Setup for release needs PLUGIN_DIR: StdUtils (start the program as the user, not elevated), UserInfo and WinShell"
  !endif
!endif

!ifdef SANDBOX
  !define MUTEX_TAG "-${SANDBOX}"
!else
  !define MUTEX_TAG ""
!endif

Name "${PRODUCT_NAME}"
BrandingText "${PRODUCT_NAME} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
ShowInstDetails nevershow

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "StykAnimate"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Setup"

Var installMode      ; "CurrentUser" or "all"
Var isUpdated
Var forceRun
Var oldDir
Var oldUninstaller
Var startMenuDir
Var desktopDir
Var docsDir
Var modeAll
Var modeMe

; Where things go. In a sandbox build they are folders of the sandbox.
!macro setLocations
  !ifdef SANDBOX
    StrCpy $startMenuDir "${SANDBOX_DIR}\StartMenu"
    StrCpy $desktopDir "${SANDBOX_DIR}\Desktop"
    StrCpy $docsDir "${SANDBOX_DIR}\Documents"
    CreateDirectory $startMenuDir
    CreateDirectory $desktopDir
    CreateDirectory $docsDir
  !else
    ${If} $installMode == "all"
      SetShellVarContext all
    ${Else}
      SetShellVarContext current
    ${EndIf}
    StrCpy $startMenuDir $SMPROGRAMS
    StrCpy $desktopDir $DESKTOP
    SetShellVarContext current
    StrCpy $docsDir $DOCUMENTS
  !endif
!macroend

; The registry root of the install mode. A sandbox build always uses the current user's hive under its prefix.
!macro writeStr KEY NAME VALUE
  !ifdef SANDBOX
    WriteRegStr HKCU "${REG}${KEY}" "${NAME}" `${VALUE}`
  !else
    ${If} $installMode == "all"
      WriteRegStr HKLM "${KEY}" "${NAME}" `${VALUE}`
    ${Else}
      WriteRegStr HKCU "${KEY}" "${NAME}" `${VALUE}`
    ${EndIf}
  !endif
!macroend

!macro writeNone KEY NAME
  !ifdef SANDBOX
    WriteRegNone HKCU "${REG}${KEY}" "${NAME}"
  !else
    ${If} $installMode == "all"
      WriteRegNone HKLM "${KEY}" "${NAME}"
    ${Else}
      WriteRegNone HKCU "${KEY}" "${NAME}"
    ${EndIf}
  !endif
!macroend

!macro readStr OUT ROOT KEY NAME
  !ifdef SANDBOX
    ReadRegStr ${OUT} HKCU "${REG}${KEY}" "${NAME}"
  !else
    ReadRegStr ${OUT} ${ROOT} "${KEY}" "${NAME}"
  !endif
!macroend

; Reads from the hive of the install mode (the current user, or the machine for all users).
!macro readModeStr OUT KEY NAME
  !ifdef SANDBOX
    ReadRegStr ${OUT} HKCU "${REG}${KEY}" "${NAME}"
  !else
    ${If} $installMode == "all"
      ReadRegStr ${OUT} HKLM "${KEY}" "${NAME}"
    ${Else}
      ReadRegStr ${OUT} HKCU "${KEY}" "${NAME}"
    ${EndIf}
  !endif
!macroend

; One file type: the ProgID is the association's name, as electron-builder writes it.
!macro associate EXT PROGID
  !insertmacro writeStr "Software\Classes\.${EXT}" "" "${PROGID}"
  !insertmacro writeNone "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  !insertmacro writeStr "Software\Classes\${PROGID}" "" "${PROGID}"
  !insertmacro writeStr "Software\Classes\${PROGID}\DefaultIcon" "" '"$INSTDIR\${APP_EXE},0"'
  !insertmacro writeStr "Software\Classes\${PROGID}\shell" "" "open"
  !insertmacro writeStr "Software\Classes\${PROGID}\shell\open" "" "Open with ${PRODUCT_NAME}"
  !insertmacro writeStr "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXE}" "%1"'
!macroend

!macro registerAssociations
  !insertmacro associate "nodes" "Stick Nodes figure"
  !insertmacro associate "nodemc" "Stick Nodes movie clip"
  !insertmacro associate "stknds" "Stick Nodes project"
  !insertmacro associate "piv" "Pivot animation"
  !insertmacro associate "stk" "Pivot stick figure"
  !insertmacro associate "stykmov" "StykAnimate movieclip"
  !insertmacro associate "stkz" "StykAnimate figure"
  !insertmacro associate "styk" "StykAnimate project"
  ; The stykanimate:// link. The Electron app registers it at run time for the current user; the Setup does it so a fresh
  ; install works at once and an upgrade replaces a command that names the old program.
  !insertmacro writeStr "Software\Classes\stykanimate" "" "URL:stykanimate"
  !insertmacro writeStr "Software\Classes\stykanimate" "URL Protocol" ""
  !insertmacro writeStr "Software\Classes\stykanimate\DefaultIcon" "" '"$INSTDIR\${APP_EXE}",0'
  !insertmacro writeStr "Software\Classes\stykanimate\shell\open\command" "" '"$INSTDIR\${APP_EXE}" "%1"'
!macroend

; ---- The pages ----

!ifdef ICON_FILE
  !define MUI_ICON "${ICON_FILE}"
  !define MUI_UNICON "${ICON_FILE}"
!endif
Page custom modePage modePageLeave
!define MUI_PAGE_CUSTOMFUNCTION_PRE dirPagePre
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function modePage
  ${If} ${Silent}
    Abort
  ${EndIf}
  ${If} $isUpdated == "1"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Install ${PRODUCT_NAME} for:"
  Pop $0
  ${NSD_CreateRadioButton} 10u 28u 100% 12u "Only for me"
  Pop $modeMe
  ${NSD_CreateRadioButton} 10u 44u 100% 12u "Anyone who uses this computer (needs an administrator)"
  Pop $modeAll
  ${If} $installMode == "all"
    ${NSD_Check} $modeAll
  ${Else}
    ${NSD_Check} $modeMe
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function modePageLeave
  ${NSD_GetState} $modeAll $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $installMode "all"
    StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCT_NAME}"
    Call EnsureAdministrator
  ${Else}
    StrCpy $installMode "CurrentUser"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
  ${EndIf}
FunctionEnd

Function dirPagePre
  ${If} $isUpdated == "1"
    Abort
  ${EndIf}
FunctionEnd

; ---- Start ----

; An install for all users writes the machine's registry and Program Files: if this Setup is not an administrator's, it
; starts itself again elevated (the elevation prompt), with the same arguments and destination, and ends. A declined
; prompt ends it with the error the prompt gave. The elevated copy installs; the program it starts afterwards is started
; as the user (below), not elevated.
Function EnsureAdministrator
  !ifndef SANDBOX
    UserInfo::GetAccountType
    Pop $0
    ${If} $0 != "admin"
      ${GetParameters} $R0
      System::Call 'shell32::ShellExecuteW(p 0, w "runas", w "$EXEPATH", w "$R0 /allusers /D=$INSTDIR", p 0, i 1) p .r1'
      ${If} $1 > 32
        SetErrorLevel 0
        Quit
      ${EndIf}
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "Installing for all users needs an administrator, and the request was not approved. Install it only for you, or try again."
      ${EndIf}
      SetErrorLevel 740
      Quit
    ${EndIf}
  !endif
FunctionEnd

Function .onInit
  ; The 64-bit view of the registry, where the Electron install, the uninstaller and the program look.
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}

  ; One Setup at a time works on the install (electron-builder's installer has a mutex for the same reason). The handle
  ; is kept for the life of this process.
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\StykAnimateSetup-${APP_GUID}${MUTEX_TAG}") p .r8 ?e'
  Pop $9
  ${If} $9 = 183
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Another ${PRODUCT_NAME} Setup is already running."
    ${EndIf}
    SetErrorLevel 4
    Quit
  ${EndIf}

  ${GetParameters} $R0
  StrCpy $isUpdated "0"
  StrCpy $forceRun "0"
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $isUpdated "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
    StrCpy $forceRun "1"
  ${EndIf}
  ClearErrors

  ; The mode: an explicit flag, else the install that is there (an update stays where it is), else the current user.
  StrCpy $installMode "CurrentUser"
  !insertmacro readStr $0 HKLM "${INSTALL_KEY}" "InstallLocation"
  !ifndef SANDBOX
    ReadRegStr $1 HKCU "${INSTALL_KEY}" "InstallLocation"
    ${If} $0 != ""
    ${AndIf} $1 == ""
      StrCpy $installMode "all"
    ${EndIf}
    ${If} $1 != ""
      StrCpy $oldDir $1
    ${ElseIf} $0 != ""
      StrCpy $oldDir $0
    ${EndIf}
  !else
    StrCpy $oldDir $0
  !endif
  ${GetOptions} $R0 "/allusers" $R1
  ${IfNot} ${Errors}
    StrCpy $installMode "all"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/currentuser" $R1
  ${IfNot} ${Errors}
    StrCpy $installMode "CurrentUser"
  ${EndIf}
  ClearErrors

  ; An explicit /D= wins; otherwise an update stays where the install is.
  ${If} $oldDir != ""
  ${AndIf} $INSTDIR == "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
    StrCpy $INSTDIR $oldDir
  ${ElseIf} $INSTDIR == "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
  ${AndIf} $installMode == "all"
    StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCT_NAME}"
  ${EndIf}

  ; The previous installation is the one of the install mode: its own folder is what its uninstaller runs in.
  !insertmacro readModeStr $oldDir "${INSTALL_KEY}" "InstallLocation"

  ${If} $installMode == "all"
    Call EnsureAdministrator
  ${EndIf}
FunctionEnd

; ---- The install ----

Section "Install"
  !insertmacro setLocations

  !ifndef SANDBOX
    ; The program may still be shutting down after the update asked to be replaced: wait for it, never kill it.
    StrCpy $R9 0
    waitForExit:
      FindWindow $R8 "" "${PRODUCT_NAME}"
      ${If} $R8 != 0
      ${AndIf} $R9 < 20
        IntOp $R9 $R9 + 1
        Sleep 500
        Goto waitForExit
      ${EndIf}
  !endif

  ; ---- The previous installation, and the destination ----
  ; The previous installation's uninstall command names its own program; the folder that program is in is where its
  ; uninstaller runs (_?=), whatever the new destination is. The destination is checked first, so a refused Setup has
  ; changed nothing.
  !insertmacro readModeStr $oldUninstaller "${UNINSTALL_KEY}" "UninstallString"
  StrCpy $R4 ""
  StrCpy $oldDir ""
  ${If} $oldUninstaller != ""
    ; The command is '"<path>" /currentuser' or '"<path>" /allusers'; take the quoted path.
    StrCpy $R0 $oldUninstaller 1
    ${If} $R0 == '"'
      StrCpy $R1 $oldUninstaller "" 1
      StrCpy $R2 0
      findQuote:
        StrCpy $R3 $R1 1 $R2
        ${If} $R3 != '"'
        ${AndIf} $R3 != ""
          IntOp $R2 $R2 + 1
          Goto findQuote
        ${EndIf}
      StrCpy $R4 $R1 $R2
    ${Else}
      StrCpy $R4 $oldUninstaller
    ${EndIf}
    ${If} ${FileExists} "$R4"
      ${GetParent} "$R4" $oldDir
    ${Else}
      StrCpy $R4 ""
    ${EndIf}
  ${EndIf}

  ; The destination must be empty, absent, the old installation's own folder, or already ours (it has our program):
  ; our uninstaller removes the folder, so it must never be a folder with somebody else's files in it.
  ${If} "$INSTDIR" != "$oldDir"
    StrCpy $R7 0
    ${If} ${FileExists} "$INSTDIR\*.*"
    ${AndIfNot} ${FileExists} "$INSTDIR\${APP_EXE}"
      FindFirst $R8 $R9 "$INSTDIR\*.*"
      checkLoop:
        StrCmp $R9 "" checkDone
        StrCmp $R9 "." checkNext
        StrCmp $R9 ".." checkNext
        StrCpy $R7 1
        Goto checkDone
        checkNext:
        FindNext $R8 $R9
        Goto checkLoop
      checkDone:
      FindClose $R8
    ${EndIf}
    ${If} $R7 == 1
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "The folder $INSTDIR already holds other files. Choose an empty folder, or a new one."
      ${EndIf}
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${EndIf}

  ; Remove the previous installation with its own uninstaller, silently, from a copy (it deletes its own folder).
  ${If} $R4 != ""
    InitPluginsDir
    CopyFiles /SILENT "$R4" "$PLUGINSDIR\old-uninstaller.exe"
    ${If} $installMode == "all"
      StrCpy $R5 "/allusers"
    ${Else}
      StrCpy $R5 "/currentuser"
    ${EndIf}
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA $R5 --updated _?=$oldDir' $R6
    ${If} $R6 != 0
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "The previous version could not be removed (error $R6)."
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
    ; The old uninstaller was run in place (_?=) and could not delete itself.
    Delete "$oldDir\${UNINSTALL_EXE}"
    RMDir "$oldDir"
  ${EndIf}

  SetOutPath $INSTDIR
  File /r "${SOURCE_DIR}\*"
  WriteUninstaller "$INSTDIR\${UNINSTALL_EXE}"

  ; Where this install lives, and the entry in Settings > Apps.
  !insertmacro writeStr "${INSTALL_KEY}" "InstallLocation" "$INSTDIR"
  !insertmacro writeStr "${INSTALL_KEY}" "KeepShortcuts" "true"
  !insertmacro writeStr "${INSTALL_KEY}" "ShortcutName" "${PRODUCT_NAME}"
  ${If} $installMode == "all"
    StrCpy $R5 "/allusers"
  ${Else}
    StrCpy $R5 "/currentuser"
  ${EndIf}
  !insertmacro writeStr "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME} ${VERSION}"
  !insertmacro writeStr "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALL_EXE}" $R5'
  !insertmacro writeStr "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALL_EXE}" $R5 /S'
  !insertmacro writeStr "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  !insertmacro writeStr "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  !insertmacro writeStr "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  !insertmacro writeStr "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_NAME}"
  !insertmacro registerAssociations

  ; Shortcuts, named as before, carrying the application id the running program sets for itself.
  CreateShortCut "$startMenuDir\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$desktopDir\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  !ifdef PLUGIN_DIR
    WinShell::SetLnkAUMI "$startMenuDir\${PRODUCT_NAME}.lnk" "${APP_ID}"
    WinShell::SetLnkAUMI "$desktopDir\${PRODUCT_NAME}.lnk" "${APP_ID}"
  !endif

  ; The library folder belongs to the user: created here, kept on uninstall.
  CreateDirectory "$docsDir\${PRODUCT_NAME}\library"

  !ifndef SANDBOX
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
  !endif

  ; --force-run: start the program again. An elevated Setup (an all-users install, or another administrator's account)
  ; must not leave an elevated editor behind: the program is started as the logged-in user, in the user's session.
  ${If} $forceRun == "1"
  ${AndIf} ${Silent}
    !ifdef SANDBOX
      !define LAUNCH_ARGS "--installer-test"
    !else
      !define LAUNCH_ARGS ""
    !endif
    !ifdef PLUGIN_DIR
      push `$INSTDIR\${APP_EXE}`
      push `open`
      push `${LAUNCH_ARGS}`
      StdUtils::ExecShellAsUser /NOUNLOAD
      pop $0
    !else
      Exec '"$INSTDIR\${APP_EXE}" ${LAUNCH_ARGS}'
    !endif
  ${EndIf}
SectionEnd

; ---- The uninstaller ----

!ifdef BUILD_UNINSTALLER
!endif

Function un.onInit
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  ${GetParameters} $R0
  StrCpy $installMode "CurrentUser"
  ${GetOptions} $R0 "/allusers" $R1
  ${IfNot} ${Errors}
    StrCpy $installMode "all"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/S" $R1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}
  ClearErrors
FunctionEnd

!macro unWriteRoot
!macroend

Section "Uninstall"
  ; Registry: the same keys the install wrote.
  !macro unDeleteKey KEY
    !ifdef SANDBOX
      DeleteRegKey HKCU "${REG}${KEY}"
    !else
      ${If} $installMode == "all"
        DeleteRegKey HKLM "${KEY}"
      ${Else}
        DeleteRegKey HKCU "${KEY}"
      ${EndIf}
    !endif
  !macroend
  !macro unDeleteValue KEY NAME
    !ifdef SANDBOX
      DeleteRegValue HKCU "${REG}${KEY}" "${NAME}"
    !else
      ${If} $installMode == "all"
        DeleteRegValue HKLM "${KEY}" "${NAME}"
      ${Else}
        DeleteRegValue HKCU "${KEY}" "${NAME}"
      ${EndIf}
    !endif
  !macroend
  !macro unAssociate EXT PROGID
    !insertmacro unDeleteValue "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
    !insertmacro unDeleteKey "Software\Classes\${PROGID}"
  !macroend
  !insertmacro unAssociate "nodes" "Stick Nodes figure"
  !insertmacro unAssociate "nodemc" "Stick Nodes movie clip"
  !insertmacro unAssociate "stknds" "Stick Nodes project"
  !insertmacro unAssociate "piv" "Pivot animation"
  !insertmacro unAssociate "stk" "Pivot stick figure"
  !insertmacro unAssociate "stykmov" "StykAnimate movieclip"
  !insertmacro unAssociate "stkz" "StykAnimate figure"
  !insertmacro unAssociate "styk" "StykAnimate project"
  !insertmacro unDeleteKey "Software\Classes\stykanimate"
  !insertmacro unDeleteKey "${UNINSTALL_KEY}"
  !insertmacro unDeleteKey "${INSTALL_KEY}"

  ; Shortcuts.
  !ifdef SANDBOX
    Delete "${SANDBOX_DIR}\StartMenu\${PRODUCT_NAME}.lnk"
    Delete "${SANDBOX_DIR}\Desktop\${PRODUCT_NAME}.lnk"
  !else
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    SetShellVarContext current
  !endif

  ; The program's files; the library in Documents is the user's and stays.
  Delete "$INSTDIR\${UNINSTALL_EXE}"
  RMDir /r "$INSTDIR"
  !ifndef SANDBOX
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
  !endif
SectionEnd
