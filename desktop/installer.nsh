; Use the current user's real Documents folder, including redirected/OneDrive paths.
; Library contents belong to the user and are deliberately retained on uninstall.
!macro customInstall
  SetShellVarContext current
  CreateDirectory "$DOCUMENTS\StykAnimate\library"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend
