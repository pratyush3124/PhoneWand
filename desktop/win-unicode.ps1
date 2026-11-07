# Types Unicode text on Windows (libnut's typeString drops non-ASCII characters).
# Reads one base64-encoded UTF-8 string per line on stdin, types it with
# SendInput(KEYEVENTF_UNICODE), and answers "ok" for each line.
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UnicodeTyper {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  const uint KEYBOARD = 1, UNICODE = 4, KEYUP = 2;
  public static void Type(string s) {
    var inputs = new INPUT[s.Length * 2];
    for (int i = 0; i < s.Length; i++) {
      inputs[2 * i].type = KEYBOARD; inputs[2 * i].u.ki.wScan = s[i]; inputs[2 * i].u.ki.dwFlags = UNICODE;
      inputs[2 * i + 1].type = KEYBOARD; inputs[2 * i + 1].u.ki.wScan = s[i]; inputs[2 * i + 1].u.ki.dwFlags = UNICODE | KEYUP;
    }
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
[Console]::Out.WriteLine("ready")
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { [UnicodeTyper]::Type([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))) } catch {}
  [Console]::Out.WriteLine("ok")
}
