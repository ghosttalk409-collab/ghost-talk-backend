package com.ghosttalk.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int REQ_POST_NOTIFICATIONS = 4701;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registers the small local plugin that starts/stops the alerts connection.
        // Must happen before super.onCreate(), otherwise Capacitor ignores it.
        registerPlugin(GhostAlertsPlugin.class);
        super.onCreate(savedInstanceState);
        applySecureFlag();

        // Android 13+ (API 33) only lets an app post notifications after the app itself asks for
        // POST_NOTIFICATIONS. Nothing asked before, so the system switch stayed OFF, no channel was
        // ever created and every alert was silently dropped. Done natively here so the dialog always
        // appears, even if the web layer fails to load.
        GhostAlertService.createChannels(this);
        askForNotifications();
    }

    @Override
    public void onResume() {
        super.onResume();
        // Re-assert on every resume: some OEM ROMs (MIUI/HyperOS included) drop window flags
        // when the activity returns from the background, which would re-enable screenshots.
        applySecureFlag();
        askForNotifications();
    }

    // The system dialog is shown at most twice; after that Android stops asking. Ghost Talk then
    // offers a button that opens the notification settings screen directly.
    private void askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS);
        } catch (Exception ignored) {
            // A vendor ROM may refuse to show the dialog: the in-app banner still links to settings.
        }
    }

    // FLAG_SECURE is enforced by Android itself, not by JavaScript:
    //  - screenshots (power+volume, adb screencap) come back black,
    //  - screen recording / casting shows a black window,
    //  - the "recent apps" thumbnail is blanked.
    // Camera and microphone still work normally for calls and the QR scanner.
    private void applySecureFlag() {
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}
