; Custom NSIS hooks for the Windows installer/uninstaller.
;
; customInstall runs at the end of every install — a fresh install and
; an in-place update over an existing installation both hit this exact
; same code path, with no reliable signal to tell them apart. It is
; intentionally left as a no-op: wiping app data here would also erase
; the orders database, shift history, and Shopify configuration on
; every routine app update, not just a genuine fresh install.
;
; The clean-slate path is customUnInstall below: uninstalling wipes
; the app's entire userData directory (SQLite database, the encrypted
; credential vault, saved settings, and Chromium's own cache/session
; folders, which all live under the same directory), so installing
; again afterward starts genuinely clean without needing install-time
; deletion at all.
;
; Phase 177: electron-updater's NSIS updater runs this exact uninstaller
; silently before installing the new version, so this macro also fires on
; every over-the-air update, not only a real uninstall. `${isUpdated}` is
; the flag electron-builder's own NSIS include sets to tell the two apart
; (https://www.electron.build/nsis#custom-nsis-script) — without the guard
; below, the first OTA update would wipe the till's database and vault.

!macro customInstall
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$APPDATA\rubis-pos-desktop"
    RMDir "$APPDATA"
  ${endIf}
!macroend
