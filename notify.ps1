param(
  [Parameter(Mandatory = $true)][ValidateSet('ask', 'approve', 'done')][string]$Kind,
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$Sound = '1'
)

$ErrorActionPreference = 'Continue'

$pidFile = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-ask-alert.pid'

# ---------------------------------------------------------------------------
# 0) Close the popup left by a previous reminder so they never stack up.
# ---------------------------------------------------------------------------
try {
  if (Test-Path $pidFile) {
    $oldPid = [int](Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($oldPid -gt 0 -and $oldPid -ne $PID) {
      Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    }
  }
}
catch { }
try { Set-Content -Path $pidFile -Value $PID -ErrorAction SilentlyContinue } catch { }

$toastOk = $false
$flashOk = $false
$soundOk = $false
$popupOk = $false

# ---------------------------------------------------------------------------
# Reminder channels. The card is created and shown first (see 1), and all
# three of these run from its Loaded handler: compiling the P/Invoke type
# below takes ~120 ms and PlaySync used to block for the whole wav (~1.8 s),
# which is why the taskbar flashed a second or two before the card appeared.
# ---------------------------------------------------------------------------

# Native Windows toast (best effort; skipped silently when Windows
# notifications are turned off).
function Invoke-Toast {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $titleXml = [System.Security.SecurityElement]::Escape($Title)
    $bodyXml = [System.Security.SecurityElement]::Escape($Body)
    $scenario = if ($Kind -eq 'done') { 'default' } else { 'reminder' }
    $audio = if ($Sound -eq '1') { '<audio src="ms-winsoundevent:Notification.Reminder" />' } else { '<audio silent="true" />' }
    $xml = '<toast scenario="' + $scenario + '"><visual><binding template="ToastGeneric">' +
      '<text>' + $titleXml + '</text><text>' + $bodyXml + '</text>' +
      '</binding></visual>' + $audio + '</toast>'

    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    $script:toastOk = $true
  }
  catch { $script:toastOk = $false }
}

# Taskbar flash: FlashWindowEx on the DeepSeek Harness window,
# FLASHW_ALL(3) | FLASHW_TIMERNOFG(12) -> keeps flashing until refocused.
function Invoke-Flash {
  try {
    if (-not ('DshAlertFlash' -as [type])) {
      Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshAlertFlash {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout;
  }
}
'@
    }

    $script:target = [IntPtr]::Zero
    $callback = [DshAlertFlash+EnumProc]{
      param($h, $l)
      if ([DshAlertFlash]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 512
        [void][DshAlertFlash]::GetWindowText($h, $sb, $sb.Capacity)
        $t = $sb.ToString()
        if ($t -like '*DeepSeek*') {
          $script:target = $h
          return $false
        }
      }
      return $true
    }
    [void][DshAlertFlash]::EnumWindows($callback, [IntPtr]::Zero)

    if ($script:target -ne [IntPtr]::Zero) {
      $info = New-Object DshAlertFlash+FLASHWINFO
      $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][DshAlertFlash+FLASHWINFO])
      $info.hwnd = $script:target
      $info.dwFlags = 15
      $info.uCount = 0
      $info.dwTimeout = 0
      [void][DshAlertFlash]::FlashWindowEx([ref]$info)
      $script:flashOk = $true
    }
  }
  catch { $script:flashOk = $false }
}

# Attention sound (toasts can be muted by Do-Not-Disturb). Play() is
# asynchronous, so the card never waits for the wav to finish.
function Invoke-Sound {
  if ($Sound -ne '1') { return }
  try {
    $wav = Join-Path $env:SystemRoot 'Media\Windows Notify Messaging.wav'
    if (Test-Path $wav) {
      $script:player = New-Object System.Media.SoundPlayer $wav
      $script:player.Play()
    }
    else { [System.Media.SystemSounds]::Exclamation.Play() }
    $script:soundOk = $true
  }
  catch { $script:soundOk = $false }
}

# ---------------------------------------------------------------------------
# 1) Always-on-top popup card in the lower-right corner. This works even when
#    Windows toast notifications are disabled, and it never steals focus.
#    It is built and shown before anything else so it appears as soon as the
#    process can paint; the other channels follow once it is on screen.
# ---------------------------------------------------------------------------
try {
  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase

  $win = New-Object System.Windows.Window
  $win.WindowStyle = 'None'
  $win.AllowsTransparency = $true
  $win.Background = [System.Windows.Media.Brushes]::Transparent
  $win.Topmost = $true
  $win.ShowActivated = $false
  $win.ShowInTaskbar = $false
  $win.ResizeMode = 'NoResize'
  $win.Width = 470
  $win.Height = 158
  $win.WindowStartupLocation = 'Manual'

  $card = New-Object System.Windows.Controls.Border
  $card.CornerRadius = New-Object System.Windows.CornerRadius(12)
  $accent = if ($Kind -eq 'done') { [System.Windows.Media.Color]::FromArgb(255, 120, 220, 160) } else { [System.Windows.Media.Color]::FromArgb(255, 90, 210, 250) }
  $card.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(250, 15, 21, 36))
  $card.BorderBrush = New-Object System.Windows.Media.SolidColorBrush $accent
  $card.BorderThickness = New-Object System.Windows.Thickness(1.5)
  $card.Padding = New-Object System.Windows.Thickness(18, 13, 18, 13)

  $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $shadow.BlurRadius = 26
  $shadow.Opacity = 0.65
  $shadow.ShadowDepth = 5
  $shadow.Color = [System.Windows.Media.Colors]::Black
  $card.Effect = $shadow

  $panel = New-Object System.Windows.Controls.StackPanel
  $head = New-Object System.Windows.Controls.TextBlock
  $head.Text = $Title
  $head.FontSize = 17
  $head.FontWeight = 'SemiBold'
  $head.TextWrapping = 'Wrap'
  $head.Foreground = New-Object System.Windows.Media.SolidColorBrush $accent
  $text = New-Object System.Windows.Controls.TextBlock
  $text.Text = $Body
  $text.FontSize = 13.5
  $text.Margin = New-Object System.Windows.Thickness(0, 6, 0, 0)
  $text.TextWrapping = 'Wrap'
  $text.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(196, 210, 228))
  $hint = New-Object System.Windows.Controls.TextBlock
  $hint.Text = '点击关闭 · 或稍后自动消失'
  $hint.FontSize = 11
  $hint.Margin = New-Object System.Windows.Thickness(0, 9, 0, 0)
  $hint.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(118, 136, 162))
  [void]$panel.Children.Add($head)
  [void]$panel.Children.Add($text)
  [void]$panel.Children.Add($hint)
  $card.Child = $panel
  $win.Content = $card

  $area = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $area.Right - $win.Width - 26
  $win.Top = $area.Bottom - $win.Height - 26

  $win.Add_MouseDown({ $win.Close() })
  $win.Add_KeyDown({ $win.Close() })

  # Runs the moment the card is on screen.
  $win.Add_Loaded({
    $script:popupOk = $true
    Invoke-Toast
    Invoke-Flash
    Invoke-Sound
  })

  $seconds = if ($Kind -eq 'done') { 9 } else { 13 }
  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds($seconds)
  $timer.Add_Tick({ $timer.Stop(); $win.Close() })
  $timer.Start()

  [void]$win.ShowDialog()
}
catch {
  # No card (missing WPF, headless session): the reminders still have to land.
  Invoke-Toast
  Invoke-Flash
  Invoke-Sound
  $popupOk = $false
}

try { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue } catch { }

Write-Output ('dsh-ask-alert:kind={0};toast={1};flash={2};sound={3};popup={4}' -f $Kind, $toastOk, $flashOk, $soundOk, $popupOk)
