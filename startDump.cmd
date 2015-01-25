@echo off
cls

..\..\node.exe app.js %1 %2 %3 %4 %5 %6 %7

rem *** use this with debugger ***
rem start node.exe --debug index.js
rem node-inspector.cmd

pause
