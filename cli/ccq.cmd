@echo off
rem ccq - short wrapper for the Command Code quota CLI.
rem Forwards every argument to cli.mjs (--json / --watch / --ascii / --help).
node "%~dp0cli.mjs" %*
