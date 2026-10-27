// Keeps the dashboard window on top (Windows). Chrome extensions can't do
// this themselves, so the bridge asks Windows via a fixed PowerShell script.
//
// The dashboard first gives its window a one-time title like
// "MMF-PIN-k3j9x2q8"; we find the visible window with exactly that title and
// set or clear "topmost". The title is validated and passed through an
// environment variable, never pasted into the script.

import { execFile } from 'node:child_process';

export const PIN_TITLE = /^MMF-PIN-[a-z0-9]{8,32}$/;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class MmfPin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (IsWindowVisible(h) && sb.ToString().StartsWith(title)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$title = $env:MMF_PIN_TITLE
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 20 -and $hwnd -eq [IntPtr]::Zero; $i++) { $hwnd = [MmfPin]::Find($title); if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 } }
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NOT_FOUND'; exit 0 }
$after = if ($env:MMF_PIN_ON -eq '1') { [IntPtr](-1) } else { [IntPtr](-2) }
[void][MmfPin]::SetWindowPos($hwnd, $after, 0, 0, 0, 0, 0x0013)
Write-Output 'OK'
`;

/**
 * Pins (or unpins) the window whose title starts with `title`.
 * Resolves { ok: true } or { ok: false, error }.
 */
export function pinWindow(title, pinned, { platform = process.platform, run = execFile } = {}) {
  if (!PIN_TITLE.test(String(title))) return Promise.resolve({ ok: false, error: 'Bad window title' });
  if (platform !== 'win32') return Promise.resolve({ ok: false, error: 'Pin on top is only available on Windows' });
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      env: { ...process.env, MMF_PIN_TITLE: title, MMF_PIN_ON: pinned ? '1' : '0' },
      windowsHide: true,
      timeout: 20000,
    }, (err, stdout) => {
      const out = String(stdout ?? '').trim();
      if (err) resolve({ ok: false, error: `Windows refused: ${err.message}` });
      else if (out.endsWith('NOT_FOUND')) resolve({ ok: false, error: 'Could not find the dashboard window' });
      else resolve({ ok: true });
    });
  });
}
