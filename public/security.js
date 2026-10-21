export class SecurityGuard {
  constructor() {
    this.initAntiCapture();
    this.initClipboardDefense();
  }

  initAntiCapture() {
    // 1. Block right-click context menus to prevent inspection/saving elements
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // 2. Obscure screen when window loses focus (prevents background app-switcher thumbnails)
    window.addEventListener('blur', () => {
      document.body.classList.add('privacy-blur');
    });

    window.addEventListener('focus', () => {
      document.body.classList.remove('privacy-blur');
    });

    // 3. Detect keyboard shortcuts used for screen capture (PrintScreen / Cmd+Shift+3)
    document.addEventListener('keydown', (e) => {
      if (
        e.key === 'PrintScreen' ||
        (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'C' || e.key === 'J')) ||
        (e.metaKey && e.altKey && e.key === '3')
      ) {
        e.preventDefault();
        this.triggerSecurityWarning('⚠️ Security Alert: Screen capture attempt blocked.');
      }
    });
  }

  initClipboardDefense() {
    // Purge clipboard on copy attempts outside secure context
    document.addEventListener('copy', (e) => {
      e.clipboardData.setData('text/plain', '[GHOST TALK: CONTENT REDACTED FOR SECURITY]');
      e.preventDefault();
    });
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