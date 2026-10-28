; Framecast Windows installer (NSIS 3). Built by packaging/windows/build.sh,
; which passes /DVERSION=... /DSTAGE=<staged app folder> /DOUTFILE=<setup.exe>.
;
; Installs per user into %LOCALAPPDATA%\Programs\Framecast, so no admin
; rights or UAC prompt are needed. User data lives in %LOCALAPPDATA%\Framecast.

; Framecast.exe and ffmpeg.exe are x64-only, so the installer is too.
Target amd64-unicode
SetCompressor /SOLID lzma
ManifestDPIAware true
RequestExecutionLevel user

!include "MUI2.nsh"

!define APP_NAME "Framecast"
!define APP_EXE "Framecast.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
BrandingText "${APP_NAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "${APP_NAME}"

!define MUI_ICON "framecast.ico"
!define MUI_UNICON "framecast.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "This will install ${APP_NAME} ${VERSION}, an AI video studio that runs in your browser.$\r$\n$\r$\nThis build is in demo mode: videos are placeholder renders made on your computer, not real AI output.$\r$\n$\r$\nNo administrator rights are needed."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\THIRD-PARTY-NOTICES.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; A running copy locks Framecast.exe and ffmpeg.exe; stop it before
; overwriting or removing files.
!macro StopRunningApp
  nsExec::Exec 'taskkill /F /IM "${APP_EXE}"'
  Pop $0
  Sleep 500
!macroend

Section "${APP_NAME} (required)" SecApp
  SectionIn RO
  !insertmacro StopRunningApp

  SetOutPath "$INSTDIR"
  ; Replace the previous version's files; user data is stored elsewhere.
  RMDir /r "$INSTDIR\public"
  File /r "${STAGE}\*.*"
  File "framecast.ico"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\framecast.ico"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\framecast.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\framecast.ico"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApp} "The ${APP_NAME} app, its bundled ffmpeg and fonts, and Start menu shortcuts."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Add a ${APP_NAME} shortcut to the desktop."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  !insertmacro StopRunningApp

  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\fonts"
  RMDir /r "$INSTDIR\ffmpeg"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\framecast.ico"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"

  ; Videos and credits are the user's; only remove them when asked.
  ; Silent uninstalls (/S) keep them.
  IfFileExists "$LOCALAPPDATA\${APP_NAME}\*.*" 0 done
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete your Framecast videos and settings?$\r$\n($LOCALAPPDATA\${APP_NAME})" \
      /SD IDNO IDNO done
    RMDir /r "$LOCALAPPDATA\${APP_NAME}"
  done:
SectionEnd
