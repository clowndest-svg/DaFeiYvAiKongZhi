$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BizhiDesktop {
  public delegate bool EnumWindow(IntPtr hwnd, IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindow callback, IntPtr value);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Keyboard keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Union input; }
  [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count, Input[] input, int size);
  public static void Send(Input input) { if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)))!=1) throw new Exception("Windows 拒绝输入，可能是目标窗口权限更高或桌面被锁定"); }
  public static void Key(ushort key,bool up) { var i=new Input(); i.type=1; i.input.keyboard.vk=key; i.input.keyboard.flags=up?2u:0u; Send(i); }
  public static void Text(string text) { foreach(char c in text) { if(c=='\r')continue; if(c=='\n'){Key(13,false);Key(13,true);continue;} var i=new Input();i.type=1;i.input.keyboard.scan=c;i.input.keyboard.flags=4;Send(i);i.input.keyboard.flags=6;Send(i); } }
  public static void MouseInput(uint flags,int data=0) { var i=new Input();i.input.mouse.flags=flags;i.input.mouse.data=unchecked((uint)data);Send(i); }
  public static void MouseInput(uint flags) { MouseInput(flags,0); }
  public static void Focus(IntPtr hwnd) {
    uint unused; uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out unused);
    uint current=GetCurrentThreadId(); bool attached=false;
    try {
      if(foreground!=current && foreground!=0) attached=AttachThreadInput(current,foreground,true);
      ShowWindow(hwnd,9); BringWindowToTop(hwnd); SetForegroundWindow(hwnd);
    } finally { if(attached) AttachThreadInput(current,foreground,false); }
  }
}
'@
[void][BizhiDesktop]::SetProcessDPIAware()
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$result = @{ok=$true; action=$request.action}
function Target-Window {
  $handle = [IntPtr]([long]$request.window)
  if ($handle -eq [IntPtr]::Zero -or -not [BizhiDesktop]::IsWindow($handle)) { throw '请先读取窗口列表并提供有效窗口 ID' }
  if ([BizhiDesktop]::GetForegroundWindow() -ne $handle) { throw '前台窗口已变化，请重新聚焦并截图核对' }
  return $handle
}
switch ($request.action) {
  'screenshot' {
    $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($screen.Left,$screen.Top,0,0,$screen.Size)
      $bitmap.Save([string]$request.output,[System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    $result.bounds = @{left=$screen.Left;top=$screen.Top;width=$screen.Width;height=$screen.Height}
    $result.window = [BizhiDesktop]::GetForegroundWindow().ToInt64().ToString()
  }
  'windows' {
    $items = New-Object System.Collections.Generic.List[object]
    $callback = [BizhiDesktop+EnumWindow]{param($handle,$unused)
      if ([BizhiDesktop]::IsWindowVisible($handle)) {
        $title = New-Object System.Text.StringBuilder(512)
        [void][BizhiDesktop]::GetWindowText($handle,$title,$title.Capacity)
        if ($title.Length -gt 0) {
          [uint32]$windowPid = 0
          [void][BizhiDesktop]::GetWindowThreadProcessId($handle,[ref]$windowPid)
          $items.Add(@{window=$handle.ToInt64().ToString();title=$title.ToString();processId=$windowPid})
        }
      }
      return $true
    }
    [void][BizhiDesktop]::EnumWindows($callback,[IntPtr]::Zero)
    $result.windows = @($items.ToArray() | Select-Object -First 60)
    $result.foreground = [BizhiDesktop]::GetForegroundWindow().ToInt64().ToString()
  }
  'focus' {
    $handle = [IntPtr]([long]$request.window)
    if (-not [BizhiDesktop]::IsWindow($handle)) { throw '窗口已关闭，请重新读取窗口列表' }
    [BizhiDesktop]::Focus($handle)
    Start-Sleep -Milliseconds 250
    if ([BizhiDesktop]::GetForegroundWindow() -ne $handle) { throw 'Windows 未允许切换到目标窗口' }
  }
  'click' {
    [void](Target-Window)
    if ($null -eq $request.x -or $null -eq $request.y) { throw '缺少点击坐标' }
    $x=[int]$request.x; $y=[int]$request.y
    if ($x -lt $screen.Left -or $x -ge $screen.Right -or $y -lt $screen.Top -or $y -ge $screen.Bottom) { throw '点击坐标超出屏幕' }
    [void][BizhiDesktop]::SetCursorPos($x,$y)
    $count = if ($request.button -eq 'double') {2} else {1}
    for ($i=0;$i -lt $count;$i++) {
      if ($request.button -eq 'right') { [BizhiDesktop]::MouseInput(8); [BizhiDesktop]::MouseInput(16) }
      else { [BizhiDesktop]::MouseInput(2); [BizhiDesktop]::MouseInput(4) }
      if ($count -eq 2) { Start-Sleep -Milliseconds 80 }
    }
  }
  'scroll' { [void](Target-Window); [BizhiDesktop]::MouseInput(2048,[Math]::Max(-1200,[Math]::Min(1200,[int]$request.amount))) }
  'type' {
    [void](Target-Window)
    $text=[string]$request.text
    if ($text.Length -gt 4000) { throw '一次最多输入 4000 字' }
    [BizhiDesktop]::Text($text)
  }
  'key' {
    [void](Target-Window)
    $keys=@{enter=13;tab=9;escape=27;backspace=8;delete=46;left=37;up=38;right=39;down=40;home=36;end=35;pageup=33;pagedown=34;space=32}
    $parts=([string]$request.key).ToLowerInvariant().Split('+')
    $last=$parts[-1]
    if ($keys.ContainsKey($last)) { $code=$keys[$last] }
    elseif ($last -match '^[a-z0-9]$') { $code=[int][char]$last.ToUpperInvariant() }
    else { throw '不支持的按键' }
    $mods=New-Object System.Collections.Generic.List[int]
    foreach ($part in $parts | Select-Object -SkipLast 1) {
      $mod=switch ($part) {ctrl {17} alt {18} shift {16} win {91} default {throw '不支持的修饰键'}}
      $mods.Add($mod)
    }
    try {
      foreach($mod in $mods) { [BizhiDesktop]::Key($mod,$false) }
      [BizhiDesktop]::Key($code,$false); [BizhiDesktop]::Key($code,$true)
    } finally { for($i=$mods.Count-1;$i -ge 0;$i--) { [BizhiDesktop]::Key($mods[$i],$true) } }
  }
  'open_url' {
    $url=[uri]([string]$request.url)
    if ($url.Scheme -notin @('https','http') -or $url.UserInfo) { throw '只支持普通 http/https 网页' }
    Start-Process -FilePath $url.AbsoluteUri
  }
  'open_app' {
    switch ($request.app) {
      'notepad' { Start-Process -FilePath "$env:WINDIR\System32\notepad.exe" }
      'calculator' { Start-Process -FilePath "$env:WINDIR\System32\calc.exe" }
      'settings' { Start-Process -FilePath 'ms-settings:' }
      'explorer' { Start-Process -FilePath "$env:WINDIR\explorer.exe" }
      default { throw '应用可选 notepad、calculator、settings、explorer' }
    }
  }
  default { throw '未知桌面动作' }
}
$result | ConvertTo-Json -Depth 6 -Compress
