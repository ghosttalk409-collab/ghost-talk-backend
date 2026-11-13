/**
 * Ghost Talk end-to-end encryption (chat, files, and call-setup authentication).
 *
 * - Every secure session uses a FRESH ECDH P-256 key pair that lives only in memory and is
 *   non-extractable. Nothing is ever written to disk. (Per-session keys => forward secrecy.)
 * - Session keys: ECDH -> HKDF-SHA-256 -> two AES-256-GCM keys, one per direction.
 * - Every message carries a strictly increasing counter inside the ciphertext (replay protection)
 *   and is authenticated by AES-GCM (tamper protection).
 * - The server only relays opaque ciphertext. It can still see who talks to whom and when.
 * - Because the server relays the key exchange, users should compare the SECURITY CODE
 *   (fingerprint) over another channel (e.g. during a call) to rule out a malicious server.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD = enc.encode('ghost-talk/e2e/v1');
const HID_RE = /^[a-f0-9]{16}$/;

export function b64encode(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
export function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const cmpBytes = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');

/** 30-digit code (6 groups of 5) both sides can compare. */
async function fingerprintOf(first, second) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(first, second)));
  const groups = [];
  for (let g = 0; g < 6; g++) {
    let n = 0n;
    for (let i = 0; i < 5; i++) n = (n << 8n) | BigInt(d[g * 5 + i]);
    groups.push(String(n % 100000n).padStart(5, '0'));
  }
  return groups.join(' ');
}

async function newKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return { keyPair, pubBytes, pub: b64encode(pubBytes) };
}

async function deriveSession(local, theirB64) {
  const theirBytes = b64decode(theirB64);
  if (theirBytes.length !== 65 || theirBytes[0] !== 4) throw new Error('bad public key');
  if (cmpBytes(local.pubBytes, theirBytes) === 0) throw new Error('reflected key');
  const theirKey = await crypto.subtle.importKey('raw', theirBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirKey }, local.keyPair.privateKey, 256);

  const iAmFirst = cmpBytes(local.pubBytes, theirBytes) < 0;
  const first = iAmFirst ? local.pubBytes : theirBytes;
  const second = iAmFirst ? theirBytes : local.pubBytes;
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(first, second)));
  const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const derive = info => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const [k1, k2] = await Promise.all([derive('ghost-talk/e2e/v1/first-to-second'), derive('ghost-talk/e2e/v1/second-to-first')]);
  return {
    sendKey: iAmFirst ? k1 : k2,
    recvKey: iAmFirst ? k2 : k1,
    sendCtr: 0,
    lastRecv: -1,
    fingerprint: await fingerprintOf(first, second)
  };
}

export class E2E {
  /**
   * @param {(obj:object)=>void} sendFn  transport for handshake messages ({type:'e2e-key', ...})
   * @param {(info:{id:string,fingerprint:string,changed:boolean})=>void} [onSession]
   */
  constructor(sendFn, onSession) {
    this.sendFn = sendFn;
    this.onSession = onSession || (() => {});
    this.sessions = new Map();        // peer name (as it appears in senderKey) -> session
    this.pending = new Map();         // hid -> { local, target, ts }
    this.pendingByTarget = new Map(); // target address -> hid
    this.aliases = new Map();         // address we used -> name the peer's messages arrive under
    this.recentInit = new Map();      // target address -> { hid, ts } of the last handshake WE started (for tie-breaking)
    this.waiters = [];                // { addr, finish }
    this._sendChain = Promise.resolve();
    this._recvChain = Promise.resolve();
  }

  resolve(addr) { return this.aliases.get(addr) || addr; }
  hasSession(addr) { return this.sessions.has(this.resolve(addr)); }
  fingerprint(addr) { const s = this.sessions.get(this.resolve(addr)); return s ? s.fingerprint : null; }

  _notify(key, ok = true) {
    for (const w of this.waiters.slice()) {
      if (w.addr === key || this.resolve(w.addr) === key) {
        if (ok && !this.hasSession(w.addr)) continue;
        w.finish(ok);
      }
    }
  }

  _prune() {
    const now = Date.now();
    for (const [t, r] of this.recentInit) if (now - r.ts > 60000) this.recentInit.delete(t);
    for (const [hid, p] of this.pending) {
      if (now - p.ts > 30000) {
        this.pending.delete(hid);
        if (this.pendingByTarget.get(p.target) === hid) this.pendingByTarget.delete(p.target);
      }
    }
  }

  async _initiate(addr) {
    this._prune();
    const hid = randomHex(8);
    // Register the attempt SYNCHRONOUSLY. If this waited until the key pair exists, a handshake from the
    // peer arriving in that gap would not see our attempt, both sides would build different sessions.
    const entry = { local: null, target: addr, ts: Date.now() };
    this.pending.set(hid, entry);
    this.pendingByTarget.set(addr, hid);
    this.recentInit.set(addr, { hid, ts: Date.now() });
    const local = await newKeyPair();
    if (this.pending.get(hid) !== entry) return;   // we lost a simultaneous start while generating the key
    entry.local = local;
    this.sendFn({ type: 'e2e-key', targetKey: addr, pub: local.pub, hid, reply: false });
  }

  /** Make sure a secure session with addr exists (starts a handshake if needed). */
  ensure(addr, timeoutMs = 8000) {
    if (this.hasSession(addr)) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const waiter = {
        addr,
        finish: ok => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.waiters = this.waiters.filter(w => w !== waiter);
          resolve(ok);
        }
      };
      const timer = setTimeout(() => waiter.finish(false), timeoutMs);
      this.waiters.push(waiter);
      if (!this.pendingByTarget.has(addr)) {
        this._initiate(addr).catch(() => waiter.finish(false));
      }
    });
  }

  /** Transport told us the peer is offline: stop waiting. */
  peerOffline(addr) {
    const hid = this.pendingByTarget.get(addr);
    if (hid) { this.pending.delete(hid); this.pendingByTarget.delete(addr); }
    for (const w of this.waiters.slice()) if (w.addr === addr) w.finish(false);
  }

  /** Handle an incoming {type:'e2e-key'} relayed by the server. `from` is msg.senderKey. */
  handleKey(from, msg) {
    return this._recvChain = this._recvChain.then(() => this._handleKey(from, msg)).catch(() => {});
  }

  async _handleKey(from, msg) {
    if (!from || !msg || typeof msg.pub !== 'string' || msg.pub.length > 200 || !HID_RE.test(msg.hid || '')) return;

    if (msg.reply) {                       // we are the initiator and this is the answer
      const p = this.pending.get(msg.hid);
      if (!p || !p.local) return;
      this.pending.delete(msg.hid);
      if (this.pendingByTarget.get(p.target) === msg.hid) this.pendingByTarget.delete(p.target);
      let session;
      try { session = await deriveSession(p.local, msg.pub); } catch { this._notify(p.target, false); return; }
      const changed = this.sessions.has(from);
      this.sessions.set(from, session);
      if (p.target !== from) this.aliases.set(p.target, from);
      this.onSession({ id: from, fingerprint: session.fingerprint, changed });
      this._notify(p.target); this._notify(from);
      return;
    }

    // Incoming handshake from a peer. Resolve a simultaneous start: the smaller hid wins.
    // This also covers a LATE init from a peer whose attempt already lost (our own attempt may even have
    // completed by now): ignoring it keeps both sides on the winning handshake.
    for (const [target, r] of this.recentInit) {
      if ((target === from || this.aliases.get(target) === from) && Date.now() - r.ts < 5000 && r.hid < msg.hid) return;
    }
    let lostTarget = null;
    for (const [target, myHid] of Array.from(this.pendingByTarget)) {
      if (target === from || this.aliases.get(target) === from) {
        if (myHid < msg.hid) return;       // our attempt wins; the peer will answer it
        this.pending.delete(myHid);
        this.pendingByTarget.delete(target);
        lostTarget = target;
      }
    }
    const local = await newKeyPair();
    let session;
    try { session = await deriveSession(local, msg.pub); } catch { return; }
    const changed = this.sessions.has(from);
    this.sessions.set(from, session);
    this.sendFn({ type: 'e2e-key', targetKey: from, pub: local.pub, hid: msg.hid, reply: true });
    if (lostTarget && lostTarget !== from) this.aliases.set(lostTarget, from);
    this.onSession({ id: from, fingerprint: session.fingerprint, changed });
    this._notify(from);
    if (lostTarget) this._notify(lostTarget);
  }

  /** Encrypt {header, bytes?} for addr. Returns a base64 string to relay as {type:'e2e-msg', payload}. */
  encrypt(addr, header, bytes) {
    const run = async () => {
      const s = this.sessions.get(this.resolve(addr));
      if (!s) throw new Error('no secure session');
      const hb = enc.encode(JSON.stringify({ ...header, n: s.sendCtr++ }));
      const body = bytes || new Uint8Array(0);
      const plain = new Uint8Array(4 + hb.length + body.length);
      new DataView(plain.buffer).setUint32(0, hb.length);
      plain.set(hb, 4);
      plain.set(body, 4 + hb.length);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, s.sendKey, plain));
      return b64encode(concat(iv, ct));
    };
    const p = this._sendChain.then(run);
    this._sendChain = p.catch(() => {});
    return p;
  }

  /** Decrypt a payload from `from` (msg.senderKey). Throws if it fails authentication or is a replay. */
  decrypt(from, payload) {
    const run = async () => {
      const s = this.sessions.get(from);
      if (!s) throw new Error('no secure session');
      const data = b64decode(payload);
      if (data.length < 12 + 16 + 4) throw new Error('short');
      const plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: AAD }, s.recvKey, data.subarray(12)));
      const hlen = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
      if (hlen > plain.length - 4) throw new Error('bad frame');
      const header = JSON.parse(dec.decode(plain.subarray(4, 4 + hlen)));
      if (!Number.isInteger(header.n) || header.n <= s.lastRecv) throw new Error('replayed or out-of-order');
      s.lastRecv = header.n;
      return { header, bytes: plain.slice(4 + hlen) };
    };
    const p = this._recvChain.then(run);
    this._recvChain = p.catch(() => {});
    return p;
  }

  /** Forget one peer's keys (end of conversation). */
  drop(addr) {
    const name = this.resolve(addr);
    this.sessions.delete(name);
    this.sessions.delete(addr);
    for (const [a, n] of Array.from(this.aliases)) if (a === addr || n === name) this.aliases.delete(a);
    this.recentInit.delete(addr);
  }

  /** Forget everything. */
  wipe() {
    this.sessions.clear();
    this.pending.clear();
    this.pendingByTarget.clear();
    this.aliases.clear();
    this.recentInit.clear();
    this.waiters.slice().forEach(w => w.finish(false));
  }
}
