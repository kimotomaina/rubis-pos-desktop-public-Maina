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

!macro customInstall
!macroend

!macro customUnInstall
  RMDir /r "$APPDATA\rubis-pos-desktop"
  RMDir "$APPDATA"
!macroend
