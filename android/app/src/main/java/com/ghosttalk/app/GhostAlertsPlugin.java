package com.ghosttalk.app;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridges window.Capacitor.Plugins.GhostAlerts.start() / .stop() to the foreground service.
 * Called from app.js when the user turns alerts on or off. No Google services involved.
 */
@CapacitorPlugin(name = "GhostAlerts")
public class GhostAlertsPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
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
}
