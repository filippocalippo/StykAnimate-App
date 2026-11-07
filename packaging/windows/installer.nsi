; The StykAnimate Setup for Windows (docs/native/shell.md, "The installer: NSIS").
;
; It keeps the upgrade path of the Electron installer: the same uninstall key (the v5 UUID electron-builder derives from
; app.stykanimate.desktop), the same install-location key, the same file-association ProgIDs, the same shortcut names and
; the same arguments an installed copy's updater passes (--updated /S --force-run /D=<dir>).
;
; Deleting is the dangerous part, and it is bounded here at its root:
;  - THIS uninstaller never deletes a folder recursively. The Setup writes a manifest of the files it installed into the
;    installation; the uninstaller removes exactly those and the folders they leave empty. Anything else stays, whatever
;    folder it was pointed at.
;  - The Electron uninstaller (electron-builder's) deletes recursively, so it is run only on a registration that agrees
;    with itself and with the folder: InstallLocation is the folder of UninstallString, the uninstaller has today's name,
;    the folder holds the Electron installation's evidence (the program and resources\app-update.yml or app.asar), and the
;    key is today's GUID in the scope being replaced. Anything else is refused, with an exit code and nothing deleted.
;  - A destination that is not empty is refused unless it is the validated installation being replaced.
;
; Exit codes: 2 the previous version could not be removed, 3 the destination is not empty, 4 another Setup is working on
; this install, 5 the registration is inconsistent, 6 the exclusion could not be taken, 740 elevation refused.
;
; Defines (makensis /D...):
;   VERSION      the version being installed (required)
;   FILES_SCRIPT the generated list of files to install and the manifest writes (required; release_feed files-script)
;   OUTFILE      the Setup to write (required)
;   ICON_FILE    the .ico of the Setup and the uninstaller (optional)
;   PLUGIN_DIR   a folder holding x86-unicode\ StdUtils, UserInfo, WinShell; electron-builder's cache has them
;   SANDBOX      a test build: every registry key goes under HKCU\Software\StykAnimateSandbox\<SANDBOX>\ (all-users keys
;                under ...\HKLM\), shortcuts and the library go under SANDBOX_DIR, no process is waited for and Explorer
;                is not notified; nothing outside the sandbox is touched
;   SANDBOX_DIR  with SANDBOX: the folder standing in for the profile's Start menu, desktop and Documents

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

!ifndef VERSION
  !error "define VERSION"
!endif
!ifndef FILES_SCRIPT
  !error "define FILES_SCRIPT"
!endif
!ifndef OUTFILE
  !error "define OUTFILE"
!endif

!define PRODUCT_NAME "StykAnimate"
!define APP_EXE "StykAnimate.exe"
!define UNINSTALL_EXE "Uninstall StykAnimate.exe"
!define MANIFEST "StykAnimate.files"
!define APP_ID "app.stykanimate.desktop"
!define APP_GUID "da89159e-9653-5b0d-96ae-4aeef8dc5497"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
!define INSTALL_KEY "Software\${APP_GUID}"
!define DEFAULT_DIR "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"

!ifdef SANDBOX
  !define REG "Software\StykAnimateSandbox\${SANDBOX}\"
  !define MUTEX_TAG "-${SANDBOX}"
!else
  !define REG ""
  !define MUTEX_TAG ""
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

Name "${PRODUCT_NAME}"
BrandingText "${PRODUCT_NAME} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "${DEFAULT_DIR}"
ShowInstDetails nevershow

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "StykAnimate"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Setup"

Var installMode      ; "CurrentUser" or "all"
Var isUpdated
Var forceRun
Var dirGiven         ; "1" when /D= named the destination
Var oldDir           ; the validated installation being replaced, or ""
Var oldUninstaller   ; its uninstaller, or ""
Var startMenuDir
Var desktopDir
Var docsDir
Var modeAll
Var modeMe
Var manifest

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

; The registry of the install mode. A sandbox build keeps the current user's keys under its prefix and the machine's
; under <prefix>HKLM\, both in the current user's hive, so both scopes can be present without touching the real one.
!macro writeStr KEY NAME VALUE
  !ifdef SANDBOX
    ${If} $installMode == "all"
      WriteRegStr HKCU "${REG}HKLM\${KEY}" "${NAME}" `${VALUE}`
    ${Else}
      WriteRegStr HKCU "${REG}${KEY}" "${NAME}" `${VALUE}`
    ${EndIf}
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
    ${If} $installMode == "all"
      WriteRegNone HKCU "${REG}HKLM\${KEY}" "${NAME}"
    ${Else}
      WriteRegNone HKCU "${REG}${KEY}" "${NAME}"
    ${EndIf}
  !else
    ${If} $installMode == "all"
      WriteRegNone HKLM "${KEY}" "${NAME}"
    ${Else}
      WriteRegNone HKCU "${KEY}" "${NAME}"
    ${EndIf}
  !endif
!macroend

; Reads a value of one scope's registration: HIVE is HKLM (all users) or HKCU (the current user).
!macro readStr OUT HIVE KEY NAME
  !ifdef SANDBOX
    !if "${HIVE}" == "HKLM"
      ReadRegStr ${OUT} HKCU "${REG}HKLM\${KEY}" "${NAME}"
    !else
      ReadRegStr ${OUT} HKCU "${REG}${KEY}" "${NAME}"
    !endif
  !else
    ReadRegStr ${OUT} ${HIVE} "${KEY}" "${NAME}"
  !endif
!macroend

; Reads from the scope of the install mode.
!macro readModeStr OUT KEY NAME
  ${If} $installMode == "all"
    !insertmacro readStr ${OUT} HKLM "${KEY}" "${NAME}"
  ${Else}
    !insertmacro readStr ${OUT} HKCU "${KEY}" "${NAME}"
  ${EndIf}
!macroend

; A folder name without its trailing backslash, so two spellings of one folder compare equal.
!macro stripSlash VAR
  StrCpy $R9 ${VAR} 1 -1
  ${If} $R9 == "\"
    StrCpy ${VAR} ${VAR} -1
  ${EndIf}
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
    StrCpy $INSTDIR "${DEFAULT_DIR}"
  ${EndIf}
FunctionEnd

Function dirPagePre
  ${If} $isUpdated == "1"
    Abort
  ${EndIf}
FunctionEnd

; ---- Start ----

; An install for all users writes the machine's registry and Program Files: if this Setup is not an administrator's, it
; starts itself again elevated (the elevation prompt), with the same arguments and destination, and ends. It has taken no
; exclusion by then (the Setup that works takes it, in the install section), so the elevated copy finds it free. A
; declined prompt ends it with an error.
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

; Stops with a message and an exit code. The exit code is in $R8, the message in $R7.
Function Refuse
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONSTOP "$R7"
  ${EndIf}
  SetErrorLevel $R8
  Quit
FunctionEnd

Function .onInit
  ; The 64-bit view of the registry, where the Electron install, the uninstaller and the program look.
  ${If} ${RunningX64}
    SetRegView 64
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

  ; The scope and the destination are resolved together, from what is registered. NSIS has put /D= in $INSTDIR already.
  StrCpy $dirGiven "0"
  ${If} "$INSTDIR" != "${DEFAULT_DIR}"
    StrCpy $dirGiven "1"
  ${EndIf}
  !insertmacro readStr $R4 HKCU "${INSTALL_KEY}" "InstallLocation"
  !insertmacro readStr $R5 HKLM "${INSTALL_KEY}" "InstallLocation"
  !insertmacro stripSlash $R4
  !insertmacro stripSlash $R5
  StrCpy $R6 "$INSTDIR"
  !insertmacro stripSlash $R6

  StrCpy $installMode "CurrentUser"
  StrCpy $R1 ""
  ${GetOptions} $R0 "/allusers" $R2
  ${IfNot} ${Errors}
    StrCpy $R1 "all"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/currentuser" $R2
  ${IfNot} ${Errors}
    StrCpy $R1 "CurrentUser"
  ${EndIf}
  ClearErrors

  ${If} $R1 != ""
    ; An explicit scope is the scope.
    StrCpy $installMode $R1
  ${ElseIf} $dirGiven == "1"
    ; A legacy updater names the running installation and no scope: it is the scope whose registration names that folder.
    ; Nothing registered there is a new installation, which is for the current user unless asked otherwise.
    ${If} $R5 != ""
    ${AndIf} "$R6" == "$R5"
      StrCpy $installMode "all"
    ${EndIf}
  ${ElseIf} $R5 != ""
  ${AndIf} $R4 == ""
    StrCpy $installMode "all"
  ${EndIf}

  ${If} $dirGiven == "0"
    ; No destination named: the scope's registered installation, else the scope's default folder.
    ${If} $installMode == "all"
      ${If} $R5 != ""
        StrCpy $INSTDIR $R5
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCT_NAME}"
      ${EndIf}
    ${ElseIf} $R4 != ""
      StrCpy $INSTDIR $R4
    ${EndIf}
  ${EndIf}

  ${If} $installMode == "all"
    Call EnsureAdministrator
  ${EndIf}
FunctionEnd

; The exclusion of the install transaction: one Setup at a time works on an install, across sessions (a named mutex in
; the global namespace, taken by the Setup that actually works, which is the elevated one). For all users it admits only
; administrators and SYSTEM. Not being able to take it is a refusal, never a reason to go on.
Function TakeSetupLock
  ${If} $installMode == "all"
    System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "D:P(A;;GA;;;BA)(A;;GA;;;SY)", i 1, *p .r2, p 0) i .r3'
    ${If} $3 = 0
      StrCpy $R7 "The Setup could not secure its lock (error)."
      StrCpy $R8 6
      Call Refuse
    ${EndIf}
    System::Call '*(i 12, p r2, i 0) p .r4'
    System::Call 'kernel32::CreateMutexW(p r4, i 0, w "Global\StykAnimateSetup-machine-${APP_GUID}${MUTEX_TAG}") p .r8 ?e'
  ${Else}
    ReadEnvStr $R7 USERNAME
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Global\StykAnimateSetup-user-$R7-${APP_GUID}${MUTEX_TAG}") p .r8 ?e'
  ${EndIf}
  Pop $9
  ${If} $8 = 0
    StrCpy $R7 "Another Setup holds this installation, or the Setup could not take its lock (error $9)."
    StrCpy $R8 6
    Call Refuse
  ${EndIf}
  ${If} $9 = 183
    StrCpy $R7 "Another ${PRODUCT_NAME} Setup is already working on this installation."
    StrCpy $R8 4
    Call Refuse
  ${EndIf}
  ; The handle in $8 stays open for the life of this process.
FunctionEnd

; Finds the installation this Setup replaces, and refuses a registration it cannot trust. Sets $oldDir and $oldUninstaller
; (both empty for a fresh install). The old uninstaller may be electron-builder's, which deletes recursively, so it runs
; only on a record that agrees with itself and with the folder it names.
Function FindPrevious
  StrCpy $oldDir ""
  StrCpy $oldUninstaller ""
  !insertmacro readModeStr $R0 "${INSTALL_KEY}" "InstallLocation"
  !insertmacro readModeStr $R1 "${UNINSTALL_KEY}" "UninstallString"
  ${If} $R0 == ""
  ${AndIf} $R1 == ""
    Return
  ${EndIf}
  StrCpy $R7 "The installed ${PRODUCT_NAME} is registered inconsistently, so it will not be touched. Remove it from Settings, Apps, then run this Setup again."
  StrCpy $R8 5
  ${If} $R0 == ""
  ${OrIf} $R1 == ""
    Call Refuse
  ${EndIf}
  ; The command is '"<path>" /currentuser' or '"<path>" /allusers'; take the quoted path.
  StrCpy $R2 $R1 1
  ${If} $R2 != '"'
    Call Refuse
  ${EndIf}
  StrCpy $R2 $R1 "" 1
  StrCpy $R3 0
  findQuote:
    StrCpy $R4 $R2 1 $R3
    ${If} $R4 != '"'
    ${AndIf} $R4 != ""
      IntOp $R3 $R3 + 1
      Goto findQuote
    ${EndIf}
  ${If} $R4 == ""
    Call Refuse
  ${EndIf}
  StrCpy $R2 $R2 $R3
  ; The uninstaller must be today's, in the folder InstallLocation names.
  ${GetFileName} "$R2" $R3
  ${GetParent} "$R2" $R4
  !insertmacro stripSlash $R0
  !insertmacro stripSlash $R4
  ${If} "$R3" != "${UNINSTALL_EXE}"
  ${OrIf} "$R4" != "$R0"
  ${OrIfNot} ${FileExists} "$R2"
    Call Refuse
  ${EndIf}
  ; And the folder must be an installation of this program: one of ours (it has our manifest), or the Electron
  ; installation (the program, and electron-builder's own files).
  ${IfNot} ${FileExists} "$R0\${APP_EXE}"
    Call Refuse
  ${EndIf}
  ${IfNot} ${FileExists} "$R0\${MANIFEST}"
    ${IfNot} ${FileExists} "$R0\resources\app-update.yml"
    ${AndIfNot} ${FileExists} "$R0\resources\app.asar"
      Call Refuse
    ${EndIf}
  ${EndIf}
  StrCpy $oldDir $R0
  StrCpy $oldUninstaller $R2
FunctionEnd

; ---- The install ----

Section "Install"
  !insertmacro setLocations
  Call TakeSetupLock

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
  Call FindPrevious

  ; The destination must be empty or absent, or be the validated installation being replaced.
  StrCpy $R6 "$INSTDIR"
  StrCpy $R5 "$oldDir"
  !insertmacro stripSlash $R6
  ${If} "$R6" != "$R5"
    StrCpy $R7 0
    ${If} ${FileExists} "$INSTDIR\*.*"
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
      StrCpy $R7 "The folder $INSTDIR already holds files. Choose an empty folder, or a new one."
      StrCpy $R8 3
      Call Refuse
    ${EndIf}
  ${EndIf}

  ; Remove the previous installation with its own uninstaller, silently, from a copy (it cannot delete itself where it
  ; runs). It runs in the folder that was validated, never in the destination.
  ${If} $oldUninstaller != ""
    InitPluginsDir
    CopyFiles /SILENT "$oldUninstaller" "$PLUGINSDIR\old-uninstaller.exe"
    ${If} $installMode == "all"
      StrCpy $R5 "/allusers"
    ${Else}
      StrCpy $R5 "/currentuser"
    ${EndIf}
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA $R5 --updated _?=$oldDir' $R6
    ${If} $R6 != 0
      StrCpy $R7 "The previous version could not be removed (error $R6)."
      StrCpy $R8 2
      Call Refuse
    ${EndIf}
    ; The old uninstaller was run in place (_?=) and could not delete itself.
    Delete "$oldDir\${UNINSTALL_EXE}"
    RMDir "$oldDir"
  ${EndIf}

  SetOutPath $INSTDIR
  ; The files, and the manifest of exactly these.
  FileOpen $manifest "$INSTDIR\${MANIFEST}" w
  !include "${FILES_SCRIPT}"
  FileClose $manifest
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

; Whether the manifest path in $R1 is a plain path below the installation: not rooted, no drive, no parent step, no
; wildcard. $R1 becomes "" if it is not.
Function un.PlainRelativePath
  StrCpy $0 $R1 1
  ${If} $0 == "\"
  ${OrIf} $0 == "/"
  ${OrIf} $R1 == ""
    StrCpy $R1 ""
    Return
  ${EndIf}
  StrLen $1 $R1
  StrCpy $2 0
  scan:
    ${If} $2 >= $1
      Return
    ${EndIf}
    StrCpy $3 $R1 1 $2
    ${If} $3 == ":"
    ${OrIf} $3 == "*"
    ${OrIf} $3 == "?"
    ${OrIf} $3 == '"'
    ${OrIf} $3 == "<"
    ${OrIf} $3 == ">"
    ${OrIf} $3 == "|"
      StrCpy $R1 ""
      Return
    ${EndIf}
    ${If} $3 == "."
      IntOp $4 $2 + 1
      StrCpy $5 $R1 1 $4
      ${If} $5 == "."
        StrCpy $R1 ""
        Return
      ${EndIf}
    ${EndIf}
    IntOp $2 $2 + 1
    Goto scan
FunctionEnd

Section "Uninstall"
  ; The registry and the shortcuts are this installation's only if the registration names this folder: a copy of the
  ; uninstaller run from anywhere else removes neither the registration of the real installation nor anything else.
  StrCpy $R8 "$INSTDIR"
  !insertmacro stripSlash $R8
  !insertmacro readModeStr $R0 "${INSTALL_KEY}" "InstallLocation"
  !insertmacro stripSlash $R0
  ${If} "$R0" == "$R8"
    !macro unDeleteKey KEY
      !ifdef SANDBOX
        ${If} $installMode == "all"
          DeleteRegKey HKCU "${REG}HKLM\${KEY}"
        ${Else}
          DeleteRegKey HKCU "${REG}${KEY}"
        ${EndIf}
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
        ${If} $installMode == "all"
          DeleteRegValue HKCU "${REG}HKLM\${KEY}" "${NAME}"
        ${Else}
          DeleteRegValue HKCU "${REG}${KEY}" "${NAME}"
        ${EndIf}
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
  ${EndIf}

  ; The program's files: exactly those the Setup listed, then the folders they leave empty. Nothing is deleted
  ; recursively, and a file that is not in the manifest is not touched. The library in Documents is the user's.
  FileOpen $R9 "$INSTDIR\${MANIFEST}" r
  ${IfNot} ${Errors}
    manifestLoop:
      ClearErrors
      FileRead $R9 $R0
      ${If} ${Errors}
        Goto manifestDone
      ${EndIf}
      ; Drop the line ending.
      trimLine:
        StrCpy $R1 $R0 1 -1
        ${If} $R1 == "$\r"
        ${OrIf} $R1 == "$\n"
          StrCpy $R0 $R0 -1
          Goto trimLine
        ${EndIf}
      StrCpy $R2 $R0 1
      StrCpy $R1 $R0 "" 2
      Call un.PlainRelativePath
      ${If} $R1 != ""
        ${If} $R2 == "F"
          Delete "$INSTDIR\$R1"
        ${ElseIf} $R2 == "D"
          RMDir "$INSTDIR\$R1"
        ${EndIf}
      ${EndIf}
      Goto manifestLoop
    manifestDone:
    FileClose $R9
  ${EndIf}
  Delete "$INSTDIR\${MANIFEST}"
  Delete "$INSTDIR\${UNINSTALL_EXE}"
  RMDir "$INSTDIR"
  !ifndef SANDBOX
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
  !endif
SectionEnd
