/*
 * aumid.nsh - write/clear a shortcut's System.AppUserModel.ID from pure NSIS script.
 *
 * Why: electron-builder's NSIS templates call the WinShell plug-in for this, but
 * WinShell only carries a "Freeware" tag upstream - no license text, no source -
 * so redistributing that DLL has no permission basis. This file replaces those
 * calls with the public Windows shell API, driven by the System plug-in that ships
 * with NSIS, plus the official Win\COM.nsh / Win\Propkey.nsh interface definitions:
 *
 *   CLSID_ShellLink -> IPersistFile::Load
 *                   -> IPropertyStore::SetValue(PKEY_AppUserModel_ID)
 *                   -> IPropertyStore::Commit -> IPersistFile::Save
 *
 * Interface (no macro arguments are used; values are passed in registers, which
 * keeps the string quoting inside System::Call unambiguous):
 *
 *   StrCpy $R8 "<shortcut .lnk>"
 *   StrCpy $R9 "<AppUserModelID>"
 *   ${StudiandaSetLnkAUMI}
 *
 *   StrCpy $R8 "<shortcut .lnk>"
 *   ${StudiandaClearLnkAUMI}
 *
 *   StrCpy $R9 "<AppUserModelID>"
 *   ${StudiandaUnregisterAUMID}
 *
 * No binary is shipped and no third-party code is redistributed: script only,
 * using COM bindings that NSIS itself provides (zlib/libpng license).
 */

!ifndef __STUDIANDA_AUMID_NSH__
!define __STUDIANDA_AUMID_NSH__

!include LogicLib.nsh
!include Win\COM.nsh
!include Win\Propkey.nsh

!define STUDIANDA_STGM_READWRITE 2
!define STUDIANDA_AUMID_BUFSIZE 1024

/* ${StudiandaSetLnkAUMI}: $R8 = .lnk path, $R9 = AppUserModelID. */
!macro StudiandaSetLnkAUMI
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} R1 ""
  ${If} $R1 P<> 0
    ${IUnknown::QueryInterface} $R1 '("${IID_IPersistFile}",.R3)'
    ${If} $R3 P<> 0
      ${IPersistFile::Load} $R3 '("$R8",${STUDIANDA_STGM_READWRITE})'
      ${IUnknown::QueryInterface} $R1 '("${IID_IPropertyStore}",.R4)'
      ${If} $R4 P<> 0
        System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ID})p.R5'
        System::Call '*(&w${STUDIANDA_AUMID_BUFSIZE} "$R9")p.R6'
        System::Call '*${SYSSTRUCT_PROPVARIANT}(${VT_LPWSTR},,l $R6)p.R7'
        System::Call '$R4->6(p,p)i.R2($R5,$R7)'
        System::Call '$R4->7()i.R2'
        System::Call '$R3->6(w,i)i.R2("$R8",1)'
        System::Free $R5
        System::Free $R6
        System::Free $R7
      ${EndIf}
      ${IUnknown::Release} $R3 ''
    ${EndIf}
    ${IUnknown::Release} $R1 ''
  ${EndIf}
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
!macroend

/* ${StudiandaClearLnkAUMI}: $R8 = .lnk path. */
!macro StudiandaClearLnkAUMI
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} R1 ""
  ${If} $R1 P<> 0
    ${IUnknown::QueryInterface} $R1 '("${IID_IPersistFile}",.R3)'
    ${If} $R3 P<> 0
      ${IPersistFile::Load} $R3 '("$R8",${STUDIANDA_STGM_READWRITE})'
      ${IUnknown::QueryInterface} $R1 '("${IID_IPropertyStore}",.R4)'
      ${If} $R4 P<> 0
        System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ID})p.R5'
        System::Call '*${SYSSTRUCT_PROPVARIANT}(0,,i 0)p.R7'
        System::Call '$R4->6(p,p)i.R2($R5,$R7)'
        System::Call '$R4->7()i.R2'
        System::Call '$R3->6(w,i)i.R2("$R8",1)'
        System::Free $R5
        System::Free $R7
      ${EndIf}
      ${IUnknown::Release} $R3 ''
    ${EndIf}
    ${IUnknown::Release} $R1 ''
  ${EndIf}
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
!macroend

/* ${StudiandaUnregisterAUMID}: $R9 = AppUserModelID. */
!macro StudiandaUnregisterAUMID
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\$R9"
!macroend

/* Allow ${StudiandaXxx} invocation form. */
!define StudiandaSetLnkAUMI "!insertmacro StudiandaSetLnkAUMI"
!define StudiandaClearLnkAUMI "!insertmacro StudiandaClearLnkAUMI"
!define StudiandaUnregisterAUMID "!insertmacro StudiandaUnregisterAUMID"

!endif ; __STUDIANDA_AUMID_NSH__
