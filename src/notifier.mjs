import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { InboxError } from "./model.mjs";

const platformSounds = {
  darwin: ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"],
  win32: ["IM", "Mail", "Reminder", "SMS"],
  linux: ["message-new-instant", "message-new-email", "complete"],
};

export function validSound(value, platform) {
  return typeof value === "string" && ["none", "default", ...(platform ? platformSounds[platform] ?? [] : Object.values(platformSounds).flat())].includes(value);
}

export function desktopCapabilities(platform = process.platform) {
  return {
    supported: Object.hasOwn(platformSounds, platform),
    platform,
    sounds: ["none", "default", ...(platformSounds[platform] ?? [])].map(value => ({
      value, label: value === "none" ? "None" : value === "default" ? "System default" : value,
    })),
    help: platform === "darwin" ? "Uses macOS notifications. System notification and Focus settings control delivery." :
      platform === "win32" ? "Uses Windows PowerShell and Windows 10/11 toasts. Windows notification settings control delivery." :
      platform === "linux" ? "Requires notify-send and a graphical desktop session. Sound choices and silence are hints; your desktop may ignore them." :
        "Desktop notifications are supported on macOS, Windows and Linux.",
  };
}

export const notificationScript = `on run argv
  if item 3 of argv is "none" then
    display notification (item 2 of argv) with title (item 1 of argv)
  else
    display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)
  end if
end run`;

// Match registered IDs, not localized display names or unrelated PowerShell hosts.
export const windowsSenderScript = String.raw`
$apps = @(Get-StartApps)
$app = $null
foreach ($appId in @(
  'Microsoft.Windows.PowerShell',
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe',
  (Join-Path $PSHOME 'powershell.exe')
)) {
  $app = $apps | Where-Object { $_.AppID -eq $appId } | Select-Object -First 1
  if ($app) { break }
}
if (-not $app) { throw 'Windows PowerShell is not registered in the Start menu.' }
`;

export const windowsDeliveryScript = `
$stage = 'permission'
$setting = $null
try {
  $setting = $notifier.get_Setting().ToString()
} catch [System.Management.Automation.MethodInvocationException] {
  # Windows may not create an unpackaged sender's settings profile until its first toast.
  if ($_.Exception.GetBaseException().HResult -ne 0x80070490) { throw }
}
if ($null -ne $setting -and $setting -ne 'Enabled') { throw 'Windows notifications are disabled for the sender.' }
$stage = 'delivery'
$notifier.Show($toast)
`;

export const windowsScript = `
$ErrorActionPreference = 'Stop'
$stage = 'sender'
try {
${windowsSenderScript}
$stage = 'setup'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual><audio/></toast>')
if ($env:COPILOT_TOAST_URL) {
  $xml.DocumentElement.SetAttribute('activationType', 'protocol')
  $xml.DocumentElement.SetAttribute('launch', $env:COPILOT_TOAST_URL)
}
$texts = $xml.GetElementsByTagName('text')
$null = $texts.Item(0).AppendChild($xml.CreateTextNode($env:COPILOT_TOAST_TITLE))
$null = $texts.Item(1).AppendChild($xml.CreateTextNode($env:COPILOT_TOAST_BODY))
$audio = $xml.GetElementsByTagName('audio').Item(0)
if ($env:COPILOT_TOAST_SOUND -eq 'none') {
  $audio.SetAttribute('silent', 'true')
} else {
  $audio.SetAttribute('src', 'ms-winsoundevent:Notification.' + $env:COPILOT_TOAST_SOUND)
}
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app.AppID)
${windowsDeliveryScript}
} catch {
  [Console]::Out.WriteLine(('COPILOT_TOAST_ERROR:{0}:0x{1:X8}' -f $stage, $_.Exception.GetBaseException().HResult))
  exit 1
}
`;

function windowsFailure(error, stdout) {
  const stages = { sender: "PowerShell sender lookup", setup: "toast setup", permission: "permission check", delivery: "toast delivery" };
  const diagnostic = typeof stdout === "string" && /^COPILOT_TOAST_ERROR:(sender|setup|permission|delivery):(0x[0-9A-F]{8})\r?\n?$/.exec(stdout);
  const detail = diagnostic && diagnostic[0] === stdout ? ` Failed during ${stages[diagnostic[1]]} (HRESULT ${diagnostic[2]}).` :
    error.code === "ENOENT" ? " Built-in Windows PowerShell was not found." :
      error.killed ? " Windows PowerShell did not complete within 10 seconds." : "";
  return `Windows could not send a desktop notification.${detail} Check Windows PowerShell, its Start menu registration, and Windows notification settings.`;
}

function displayText(value) {
  // eslint-disable-next-line no-control-regex -- Remove control characters from native notification text.
  const characters = Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
  return characters.length > 500 ? `${characters.slice(0, 497).join("")}...` : characters.join("");
}

// notify-send decodes C-style backslash escapes before the daemon parses markup.
const escapeLinuxBody = text => text.replace(/\\/g, "\\\\").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function notificationURL(value) {
  if (value === undefined) return "";
  try {
    if (typeof value !== "string" || !value.startsWith("https://github.com/") || /[\s\\\p{Cc}]/u.test(value)) throw new Error();
    const url = new URL(value);
    if (url.origin !== "https://github.com" || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new InboxError("desktop_url", "Desktop notification links must use an HTTPS github.com URL without credentials.", 400);
  }
}

export async function notifyDesktop({ title, body, url, sound = "default", signal, platform = process.platform,
  execute = execFile, env = process.env } = {}) {
  if (!desktopCapabilities(platform).supported) {
    throw new InboxError("desktop_unsupported", "Desktop notifications are supported on macOS, Windows and Linux.", 400);
  }
  if (!validSound(sound, platform)) throw new InboxError("desktop_sound", "Choose a notification sound supported by this operating system.", 400);
  if (typeof title !== "string" || typeof body !== "string") throw new InboxError("desktop_content", "Desktop notifications require a title and body.", 400);
  const heading = displayText(title);
  const text = displayText(body);
  const destination = notificationURL(url);
  const options = { signal, timeout: 10_000, maxBuffer: 16_384, encoding: "utf8", windowsHide: true };
  let command;
  let args;
  if (platform === "darwin") {
    command = "/usr/bin/osascript";
    // Foundation's NSUserNotificationDefaultSoundName uses this identifier.
    args = ["-e", notificationScript, heading, text, sound === "default" ? "DefaultSoundName" : sound];
  } else if (platform === "win32") {
    command = win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsScript];
    options.env = { ...env, COPILOT_TOAST_TITLE: heading, COPILOT_TOAST_BODY: text, COPILOT_TOAST_URL: destination,
      COPILOT_TOAST_SOUND: sound === "default" ? "Default" : sound };
  } else {
    command = "notify-send";
    args = ["--app-name=GitHub Notifications", "--icon=dialog-information",
      `--hint=boolean:suppress-sound:${sound === "none"}`];
    if (!["none", "default"].includes(sound)) args.push(`--hint=string:sound-name:${sound}`);
    args.push("--", heading, escapeLinuxBody(text));
  }
  return new Promise((resolve, reject) => {
    execute(command, args, options, (error, stdout) => {
        if (signal?.aborted) return reject(new InboxError("closed", "Desktop notification watching stopped.", 410));
        if (error) {
          const message = platform === "linux" ?
            (error.code === "ENOENT" ? "notify-send is missing. Install your distribution's libnotify tools to use desktop notifications; nothing was installed automatically." :
              "Linux could not send a desktop notification. Check your graphical session, D-Bus connection and notification service.") :
            platform === "win32" ? windowsFailure(error, stdout) :
              "macOS could not send a desktop notification. Check notification permissions for the script sender in System Settings.";
          return reject(new InboxError("desktop_delivery", `${message} This alert will not be retried.`, 503));
        }
        resolve();
    });
  });
}
