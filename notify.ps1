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
$script:flashOk = $false
$script:soundOk = $false
$script:popupOk = $false

# ---------------------------------------------------------------------------
# Attention helpers. They run *after* the card is on screen (see the Loaded
# handler below): compiling the P/Invoke type and starting the sound used to
# cost 300-1500 ms before the window was even created, which is why the
# taskbar used to flash a second or two before the card appeared.
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

# Attention sound: played asynchronously, so it never delays the card.
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
# 1) Always-on-top popup card in the lower-right corner. Built first and shown
#    as soon as possible; flash + sound follow once it is visible.
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
  $win.Width = 490
  $win.Height = 178
  $win.WindowStartupLocation = 'Manual'

  $card = New-Object System.Windows.Controls.Border
  $card.Margin = New-Object System.Windows.Thickness(10)
  $card.CornerRadius = New-Object System.Windows.CornerRadius(12)
  $accent = if ($Kind -eq 'done') { [System.Windows.Media.Color]::FromArgb(255, 120, 220, 160) } else { [System.Windows.Media.Color]::FromArgb(255, 90, 210, 250) }
  $cardColor = [System.Windows.Media.Color]::FromArgb(250, 15, 21, 36)
  $cardHover = [System.Windows.Media.Color]::FromArgb(250, 27, 37, 60)
  $cardBrush = New-Object System.Windows.Media.SolidColorBrush $cardColor
  $card.Background = $cardBrush
  $borderBrush = New-Object System.Windows.Media.SolidColorBrush $accent
  $card.BorderBrush = $borderBrush
  $card.BorderThickness = New-Object System.Windows.Thickness(1.5)
  $card.Padding = New-Object System.Windows.Thickness(18, 13, 18, 13)

  # Hover state: the border brightens a little, which is the "this is clickable"
  # preview the card otherwise lacks (it has no buttons).
  $accentHover = [System.Windows.Media.Color]::FromArgb(
    255,
    [Math]::Min(255, [int]$accent.R + 70),
    [Math]::Min(255, [int]$accent.G + 70),
    [Math]::Min(255, [int]$accent.B + 70)
  )

  # Dismissing slides the card out to the right while it fades and shrinks, so a
  # click reads as a click instead of the window vanishing.
  $card.RenderTransformOrigin = New-Object System.Windows.Point(1, 0.5)
  $scale = New-Object System.Windows.Media.ScaleTransform(1, 1)
  $slide = New-Object System.Windows.Media.TranslateTransform(0, 0)
  $transform = New-Object System.Windows.Media.TransformGroup
  [void]$transform.Children.Add($scale)
  [void]$transform.Children.Add($slide)
  $card.RenderTransform = $transform

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
  $win.Left = $area.Right - $win.Width - 16
  $win.Top = $area.Bottom - $win.Height - 16

  # -------------------------------------------------------------------------
  # Dismissal animation: fade + slide right + shrink, then close for real.
  # -------------------------------------------------------------------------
  $script:closing = $false
  function Close-WithAnimation {
    if ($script:closing) { return }
    $script:closing = $true

    $duration = New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds(170))
    $ease = New-Object System.Windows.Media.Animation.CubicEase
    $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseIn

    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
    $fade.To = 0
    $fade.Duration = $duration
    $fade.EasingFunction = $ease
    $win.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)

    $shrink = New-Object System.Windows.Media.Animation.DoubleAnimation
    $shrink.To = 0.90
    $shrink.Duration = $duration
    $shrink.EasingFunction = $ease
    $scale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $shrink)
    $scale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $shrink)

    $move = New-Object System.Windows.Media.Animation.DoubleAnimation
    $move.To = 8
    $move.Duration = $duration
    $move.EasingFunction = $ease
    $slide.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $move)

    Start-DismissTimer
  }

  function Start-DismissTimer {
    $script:dismissTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:dismissTimer.Interval = [TimeSpan]::FromMilliseconds(180)
    $script:dismissTimer.Add_Tick({
      $script:dismissTimer.Stop()
      $win.Close()
    })
    $script:dismissTimer.Start()
  }

  # Hover feedback: border thickens and brightens, the fill lightens, and the
  # card grows a hair -- three small changes read better than a colour tweak.
  $script:hovering = $false
  function Set-Hover([bool]$on) {
    if ($script:hovering -eq $on) { return }
    $script:hovering = $on

    $duration = New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds(110))

    $edge = New-Object System.Windows.Media.Animation.ColorAnimation
    $edge.To = if ($on) { $accentHover } else { $accent }
    $edge.Duration = $duration
    $borderBrush.BeginAnimation([System.Windows.Media.SolidColorBrush]::ColorProperty, $edge)

    $fill = New-Object System.Windows.Media.Animation.ColorAnimation
    $fill.To = if ($on) { $cardHover } else { $cardColor }
    $fill.Duration = $duration
    $cardBrush.BeginAnimation([System.Windows.Media.SolidColorBrush]::ColorProperty, $fill)

    $card.BorderThickness = New-Object System.Windows.Thickness ($(if ($on) { 2.5 } else { 1.5 }))

  }

  # Press feedback ("缩一下"): shrink first, then dismiss, so the click is
  # acknowledged before the card starts moving away.
  $script:pressing = $false
  function Invoke-Press {
    if ($script:pressing) { return }
    $script:pressing = $true
    $press = New-Object System.Windows.Media.Animation.DoubleAnimation
    $press.To = 0.955
    $press.Duration = New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds(90))
    $scale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $press)
    $scale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $press)

    $script:pressTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:pressTimer.Interval = [TimeSpan]::FromMilliseconds(110)
    $script:pressTimer.Add_Tick({
      $script:pressTimer.Stop()
      Close-WithAnimation
    })
    $script:pressTimer.Start()
  }

  $win.Add_PreviewMouseLeftButtonDown({ Invoke-Press })
  $win.Add_KeyDown({ Close-WithAnimation })

  # Hover is polled rather than event-driven: the window is transparent and
  # topmost, and MouseEnter/MouseLeave did not reliably arrive.
  $hoverTimer = New-Object System.Windows.Threading.DispatcherTimer
  $hoverTimer.Interval = [TimeSpan]::FromMilliseconds(90)
  $hoverTimer.Add_Tick({ if (-not $script:closing) { Set-Hover $card.IsMouseOver } })
  $hoverTimer.Start()

  # Everything below runs the moment the card is on screen.
  $win.Add_Loaded({
    $script:popupOk = $true
    Invoke-Toast
    Invoke-Flash
    Invoke-Sound
  })

  $seconds = if ($Kind -eq 'done') { 9 } else { 13 }
  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds($seconds)
  $timer.Add_Tick({
    $timer.Stop()
    Close-WithAnimation
  })
  $timer.Start()

  [void]$win.ShowDialog()
}
catch {
  # No card (missing WPF, headless session): the reminders still have to land.
  Invoke-Toast
  Invoke-Flash
  Invoke-Sound
  $script:popupOk = $false
}

try { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue } catch { }

Write-Output ('dsh-ask-alert:kind={0};toast={1};flash={2};sound={3};popup={4}' -f $Kind, $toastOk, $flashOk, $soundOk, $popupOk)
