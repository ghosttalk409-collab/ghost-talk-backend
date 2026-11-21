package com.ghosttalk.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * A quiet foreground service whose only job is to stop Android from freezing the app's secure
 * WebSocket while Ghost Talk is in the background. It shows one low-importance notification
 * ("Connected for alerts"), which the user can hide from the notification shade but not disable
 * while it runs. Turning alerts off stops the service completely.
 *
 * A partial WakeLock is held only while the service is running, refreshed by a light keep-alive
 * timer and released in onDestroy (and always with a timeout, so a killed process cannot leak one).
 *
 * This replaces Firebase: nothing leaves the phone, no project credentials, no extra deploy step.
 * Android's own limit still applies - if the OS kills the app (very aggressive battery savers,
 * or the user "force stop"s it), no alert can arrive until the app is opened again.
 */
public class GhostAlertService extends Service {

    private static final String CHANNEL_ID = "ghost_keepalive";
    private static final int NOTIFICATION_ID = 4701;
    private static final String WAKE_TAG = "GhostTalk:alerts";
    private static final long KEEPALIVE_MS = 4 * 60 * 1000L;    // touch the lock every 4 minutes
    private static final long WAKE_TIMEOUT_MS = 10 * 60 * 1000L; // and let it expire on its own

    private PowerManager.WakeLock wakeLock;
    private Handler handler;
    private boolean keepAliveRunning = false;

    private final Runnable keepAlive = new Runnable() {
        @Override
        public void run() {
            acquireWakeLock();
            if (handler != null) handler.postDelayed(this, KEEPALIVE_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        handler = new Handler(Looper.getMainLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                // Android 14+ requires the matching foreground-service type; the manifest declares
                // android:foregroundServiceType="specialUse" with a PROPERTY_SPECIAL_USE_FGS_SUBTYPE.
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Exception e) {
            // e.g. the OS refused the service (permission revoked, or the 6h/type limits hit).
            // Never crash the app over a keep-alive: stop quietly and let the in-app alerts work.
            stopSelf();
            return START_NOT_STICKY;
        }

        acquireWakeLock();
        if (!keepAliveRunning && handler != null) {
            keepAliveRunning = true;
            handler.postDelayed(keepAlive, KEEPALIVE_MS);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        keepAliveRunning = false;
        if (handler != null) { handler.removeCallbacks(keepAlive); handler = null; }
        releaseWakeLock();
        try { stopForeground(true); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG);
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) {
                // A timeout means the lock can never outlive the process if onDestroy is skipped.
                wakeLock.acquire(WAKE_TIMEOUT_MS);
            }
        } catch (Exception ignored) {
            // Missing WAKE_LOCK permission or a vendor restriction: alerts still try to arrive.
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) { }
        wakeLock = null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Alerts connection", NotificationManager.IMPORTANCE_MIN);
        ch.setDescription("Keeps Ghost Talk connected so call and message alerts arrive");
        ch.setShowBadge(false);
        ch.enableVibration(false);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle("Ghost Talk")
         .setContentText("Connected for alerts")
         .setSmallIcon(android.R.drawable.stat_notify_chat)
         .setOngoing(true)
         .setShowWhen(false);
        return b.build();
    }
}
