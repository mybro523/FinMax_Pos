; ── Обычный установщик FinMax POS — для 64-разрядной Windows 10 и 11 ──
; Программа в нём собрана на новом движке Electron: в Windows 7, 8, в 32-разрядной Windows и
; в Windows 10 на процессоре ARM (64-разрядные программы x64 там не запускаются — это умеет
; только Windows 11) она не работает. Вместо программы, которая молча не откроется, установщик
; говорит словами, какой файл нужен. Установщик для Windows 7 и 8 (он же для 32-разрядной
; Windows и Windows 10 на ARM) лежит в том же выпуске; эта проверка в него не входит
; (desktop/legacy/electron-builder.yml).
;
; preInit — самое начало установки: раньше собственной проверки упаковщика «нужна 64-разрядная
; Windows», которая сама не знает про установщик для Windows 7 и 8.
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

Var /GLOBAL finmaxNotHere

!macro preInit
  StrCpy $finmaxNotHere ""
  ${If} ${AtMostWin8.1}
    StrCpy $finmaxNotHere "1"
  ${EndIf}
  ${IfNot} ${RunningX64}
    StrCpy $finmaxNotHere "1"
  ${EndIf}
  ${If} ${IsNativeARM64}
    ${IfNot} ${AtLeastBuild} 22000
      StrCpy $finmaxNotHere "1"
    ${EndIf}
  ${EndIf}
  ${If} $finmaxNotHere == "1"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Этот установщик FinMax POS — для 64-разрядной Windows 10 и 11.$\r$\n$\r$\nДля Windows 7, 8 и 32-разрядной Windows скачайте установщик «FinMax-POS-Setup-…-Windows-7-8.exe» на странице:$\r$\ngithub.com/mybro523/finmax-updates/releases/latest" /SD IDOK
    Quit
  ${EndIf}
!macroend
