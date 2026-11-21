package com.ghosttalk.app;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registers the small local plugin that starts/stops the alerts connection.
        // Must happen before super.onCreate(), otherwise Capacitor ignores it.
        registerPlugin(GhostAlertsPlugin.class);
        super.onCreate(savedInstanceState);
        applySecureFlag();
    }

    @Override
    public void onResume() {
        super.onResume();
        // Re-assert on every resume: some OEM ROMs (MIUI/HyperOS included) drop window flags
        // when the activity returns from the background, which would re-enable screenshots.
        applySecureFlag();
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
