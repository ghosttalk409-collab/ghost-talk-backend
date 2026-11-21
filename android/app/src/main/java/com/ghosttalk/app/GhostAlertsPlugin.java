package com.ghosttalk.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridges window.Capacitor.Plugins.GhostAlerts to the foreground service.
 * Called from app.js when the user turns alerts on or off. No Google services involved.
 */
@CapacitorPlugin(name = "GhostAlerts")
public class GhostAlertsPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        GhostAlertService.createChannels(getContext());
        Intent service = new Intent(getContext(), GhostAlertService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(service);
        } else {
            getContext().startService(service);
        }
        JSObject ret = new JSObject();
        ret.put("running", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), GhostAlertService.class));
        JSObject ret = new JSObject();
        ret.put("running", false);
        call.resolve(ret);
    }

    /** Reports whether Android will really show this app's notifications. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("notificationsEnabled", notificationsEnabled());
        ret.put("permission", permissionState());
        call.resolve(ret);
    }

    /**
     * Opens the exact system screen that contains the "Show notifications" switch, so a user whose
     * Android already refused the prompt once does not have to hunt through Settings.
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getContext().getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open notification settings");
        }
    }

    private boolean notificationsEnabled() {
        try {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) return nm.areNotificationsEnabled();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private String permissionState() {
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                boolean granted = getContext().checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        == PackageManager.PERMISSION_GRANTED;
                return granted ? "granted" : "denied";
            }
            return notificationsEnabled() ? "granted" : "denied";
        } catch (Exception e) {
            return "unknown";
        }
    }
}
