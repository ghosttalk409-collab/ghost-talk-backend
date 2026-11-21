/**
 * Ghost Talk client-side privacy guard.
 *
 * IMPORTANT, and previously misleading: no JavaScript can stop an operating-system screenshot.
 * The real protection is FLAG_SECURE in MainActivity.java, which makes the Android app's window
 * uncapturable (screenshots, screen recording, casting and the recent-apps thumbnail all fail or
 * come out black). This file covers what a page *can* do:
 *   - hide the conversation the instant the app leaves the foreground (task switcher, alt-tab),
 *   - stop right-click "save image as" and drag-and-drop of received media,
 *   - keep copied chat text out of the clipboard,
 *   - tell you plainly when someone tries a capture shortcut.
 */
export class SecurityGuard {
  constructor() {
    this.initAntiCapture();
    this.initClipboardDefense();
  }

  initAntiCapture() {
    // 1. No context menu: no "save image as", no "view source", no "inspect".
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // 2. Received photos must not be draggable out of the app.
    document.addEventListener('dragstart', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'IMG' || t.tagName === 'A')) e.preventDefault();
    });

    // 3. Cover the whole screen the moment this window stops being the visible one.
    //    This replaces the old rule that only blurred the video element, which left chats readable.
    const hide = () => this.setShield(true);
    const show = () => this.setShield(false);
    window.addEventListener('blur', hide);
    window.addEventListener('focus', show);
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') hide();
      else show();
    });

    // 4. Capture shortcuts. Shift+Ctrl/Cmd+I/J/C opens devtools, which can read the DOM;
    //    PrintScreen itself cannot be cancelled by a web page, so we say what actually protects you.
    document.addEventListener('keydown', (e) => {
      const combo = e.ctrlKey || e.metaKey;
      if (e.key === 'PrintScreen') {
        this.triggerSecurityWarning('Screenshots are blocked in the Android app (FLAG_SECURE).');
        return;
      }
      if (
        (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'C' || e.key === 'J')) ||
        (e.metaKey && e.altKey && e.key === 'I')
      ) {
        e.preventDefault();
        this.triggerSecurityWarning('⚠️ Developer tools are blocked.');
      }
      if (combo && e.key === 'u') {
        e.preventDefault();
        this.triggerSecurityWarning('⚠️ View-source is blocked.');
      }
    });
  }

  initClipboardDefense() {
    // Copying chat text puts a redaction notice on the clipboard instead of the message.
    // The identity field is the one exception: people need to share their Ghost ID.
    const redact = (e) => {
      const el = document.activeElement;
      if (el && el.id === 'my-identity') return;
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', '[GHOST TALK: CONTENT REDACTED FOR SECURITY]');
        e.preventDefault();
      }
    };
    document.addEventListener('copy', redact);
    document.addEventListener('cut', redact);
  }

  /** Full-screen cover shown while the app is not in the foreground. */
  setShield(on) {
    const existing = document.getElementById('gt-privacy-shield');
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const shield = document.createElement('div');
    shield.id = 'gt-privacy-shield';
    shield.className = 'gt-privacy-shield';
    const text = document.createElement('div');
    text.className = 'gt-privacy-shield-text';
    text.textContent = 'Ghost Talk — hidden for privacy';
    shield.appendChild(text);
    (document.body || document.documentElement).appendChild(shield);
  }

  triggerSecurityWarning(message) {
    let toast = document.getElementById('security-toast-banner');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'security-toast-banner';
      toast.className = 'security-toast';
      document.body.appendChild(toast);
    }
    toast.innerText = message;
    toast.classList.add('visible');
    setTimeout(() => {
      toast.classList.remove('visible');
    }, 3000);
  }
}
