"""Synthetic receiver for notify-send; no desktop UI or native alerts."""

import json
import os

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib


if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
    raise RuntimeError("The test requires an explicit private session bus")

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus(private=True)
name = dbus.service.BusName(
    "org.freedesktop.Notifications", bus=bus, do_not_queue=True,
    allow_replacement=False, replace_existing=False,
)


class Notifications(dbus.service.Object):
    @dbus.service.method("org.freedesktop.Notifications", out_signature="as")
    def GetCapabilities(self):
        return ["body", "body-markup", "sound"]

    @dbus.service.method("org.freedesktop.Notifications", out_signature="ssss")
    def GetServerInformation(self):
        return ("Synthetic notifications", "Tests", "1.0", "1.2")

    @dbus.service.method(
        "org.freedesktop.Notifications", in_signature="susssasa{sv}i",
        out_signature="u",
    )
    def Notify(self, app, replaces_id, icon, summary, body, actions, hints, timeout):
        print(json.dumps({
            "app": str(app),
            "icon": str(icon),
            "imagePath": str(hints["image-path"]) if "image-path" in hints else None,
            "summary": str(summary),
            "body": str(body),
            "actions": [str(action) for action in actions],
            "suppressSound": bool(hints["suppress-sound"]),
            "soundName": str(hints["sound-name"]) if "sound-name" in hints else None,
        }), flush=True)
        return dbus.UInt32(1)


receiver = Notifications(name, "/org/freedesktop/Notifications")
print(json.dumps({"ready": True}), flush=True)
GLib.MainLoop().run()
