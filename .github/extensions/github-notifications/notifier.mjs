import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { InboxError } from "./model.mjs";

const platformSounds = {
  darwin: ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"],
  win32: ["IM", "Mail", "Reminder", "SMS"],
  linux: ["message-new-instant", "message-new-email", "complete"],
};

export function soundValue(value) {
  return value === true || value === undefined ? "default" : value === false ? "none" : value;
}

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

export const windowsScript = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$app = Get-StartApps | Where-Object { $_.AppID -eq 'Microsoft.Windows.PowerShell' } | Select-Object -First 1
if (-not $app) { throw 'Windows PowerShell is not registered in the Start menu.' }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual><audio/></toast>')
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
if ($notifier.Setting.ToString() -ne 'Enabled') { throw 'Windows notifications are disabled for the sender.' }
$notifier.Show($toast)
`;

function displayText(value) {
  // eslint-disable-next-line no-control-regex -- Remove control characters from native notification text.
  const characters = Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
  return characters.length > 500 ? `${characters.slice(0, 497).join("")}...` : characters.join("");
}

// notify-send decodes C-style backslash escapes before the daemon parses markup.
const escapeLinuxBody = text => text.replace(/\\/g, "\\\\").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function notifyDesktop({ title, body, sound = "default", signal, platform = process.platform,
  execute = execFile, env = process.env } = {}) {
  if (!desktopCapabilities(platform).supported) {
    throw new InboxError("desktop_unsupported", "Desktop notifications are supported on macOS, Windows and Linux.", 400);
  }
  if (!validSound(sound, platform)) throw new InboxError("desktop_sound", "Choose a notification sound supported by this operating system.", 400);
  if (typeof title !== "string" || typeof body !== "string") throw new InboxError("desktop_content", "Desktop notifications require a title and body.", 400);
  const heading = displayText(title);
  const text = displayText(body);
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
    options.env = { ...env, COPILOT_TOAST_TITLE: heading, COPILOT_TOAST_BODY: text,
      COPILOT_TOAST_SOUND: sound === "default" ? "Default" : sound };
  } else {
    command = "notify-send";
    args = ["--app-name=GitHub notifications", "--icon=dialog-information",
      `--hint=boolean:suppress-sound:${sound === "none"}`];
    if (!["none", "default"].includes(sound)) args.push(`--hint=string:sound-name:${sound}`);
    args.push("--", heading, escapeLinuxBody(text));
  }
  return new Promise((resolve, reject) => {
    execute(command, args, options, error => {
        if (signal?.aborted) return reject(new InboxError("closed", "Desktop notification watching stopped.", 410));
        if (error) {
          const message = platform === "linux" ?
            (error.code === "ENOENT" ? "notify-send is missing. Install your distribution's libnotify tools to use desktop notifications; nothing was installed automatically." :
              "Linux could not send a desktop notification. Check your graphical session, D-Bus connection and notification service.") :
            platform === "win32" ? "Windows could not send a desktop notification. Check Windows PowerShell, its Start menu registration, and Windows notification settings." :
              "macOS could not send a desktop notification. Check notification permissions for the script sender in System Settings.";
          return reject(new InboxError("desktop_delivery", `${message} This alert will not be retried.`, 503));
        }
        resolve();
    });
  });
}
