// "Show in Explorer" for the dashboard. Explorer opens behind Chrome when a
// background program (the bridge) starts it, because Windows blocks windows
// from stealing focus. So after starting Explorer, a fixed PowerShell script
// finds the Explorer window showing that folder and brings it to the front.
// The folder is passed through an environment variable, never pasted into
// the script.

import path from 'node:path';
import { execFile } from 'node:child_process';

const FOCUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class MmfFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
$want = [IO.Path]::GetFullPath($env:MMF_REVEAL_DIR).TrimEnd('\')
$shell = New-Object -ComObject Shell.Application
$hwnd = 0
for ($i = 0; $i -lt 30 -and $hwnd -eq 0; $i++) {
  foreach ($w in @($shell.Windows())) {
    try { $p = $w.Document.Folder.Self.Path } catch { continue }
    if ($p -and $p.TrimEnd('\') -ieq $want) { $hwnd = $w.HWND }
  }
  if ($hwnd -eq 0) { Start-Sleep -Milliseconds 100 }
}
if ($hwnd -eq 0) { Write-Output 'NOT_FOUND'; exit 0 }
$h = [IntPtr]$hwnd
if ([MmfFocus]::IsIconic($h)) { [void][MmfFocus]::ShowWindow($h, 9) }
# A tap of Alt lets this process hand focus to another window.
[MmfFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[MmfFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][MmfFocus]::SetForegroundWindow($h)
Write-Output 'OK'
`;

export function revealInFileManager(target, { select }, { platform = process.platform, run = execFile } = {}) {
  if (platform === 'win32') {
    // Explorer parses its own command line: the path must be quoted exactly
    // like /select,"C:\a b\c.zip", which Node's default quoting breaks.
    const arg = select ? `/select,"${target}"` : `"${target}"`;
    run('explorer.exe', [arg], { windowsVerbatimArguments: true });
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FOCUS_SCRIPT], {
      env: { ...process.env, MMF_REVEAL_DIR: select ? path.win32.dirname(target) : target },
      windowsHide: true,
      timeout: 15000,
    }, () => {});
  } else if (platform === 'darwin') {
    run('open', select ? ['-R', target] : [target]);
  } else {
    run('xdg-open', [select ? path.dirname(target) : target]);
  }
}
