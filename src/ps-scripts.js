'use strict';
/**
 * ps-scripts.js —— 内嵌的 PowerShell 脚本
 * 打包进 asar 后外部进程无法直接读取 .ps1 文件, 因此运行期写入临时文件再执行。
 *
 * 仅保留一个用途: 解析 .lnk 快捷方式的真实目标路径/图标位置。
 * 解析失败不影响使用 —— 快捷方式本身可以直接交给系统启动。
 */

const RESOLVE_LNK_PS = String.raw`
param([string]$Lnk, [string]$OutFile)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($Lnk)
$o = [pscustomobject]@{
  target   = [string]$s.TargetPath
  args     = [string]$s.Arguments
  iconPath = [string]$s.IconLocation
  name     = [System.IO.Path]::GetFileNameWithoutExtension($Lnk)
}
[System.IO.File]::WriteAllText($OutFile, (ConvertTo-Json -InputObject $o -Compress), (New-Object System.Text.UTF8Encoding($false)))
`;

module.exports = { RESOLVE_LNK_PS };
