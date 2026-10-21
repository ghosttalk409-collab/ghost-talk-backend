/**
 * Production E2EE Frame Encryptor / Decryptor
 * Uses WebRTC Encoded Transforms with AES-128-GCM
 */
export class FrameCrypto {
  constructor() {
    this.key = null;
    this.cryptoKey = null;
  }

  /**
   * Derive a cryptographic key from a shared room passphrase/secret.
   */
  async setSecretKey(passphrase) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    this.cryptoKey = await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: enc.encode("GhostTalkSalt2026"),
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 128 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Transforms an outgoing media stream frame (Encrypt)
   */
  async encryptTransform(frame, controller) {
    if (!this.cryptoKey) {
      controller.enqueue(frame);
      return;
    }

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      this.cryptoKey,
      frame.data
    );

    // Append IV (12 bytes) to the encrypted payload
    const newPayload = new Uint8Array(encrypted.byteLength + 12);
    newPayload.set(new Uint8Array(encrypted), 0);
    newPayload.set(iv, encrypted.byteLength);

    frame.data = newPayload.buffer;
    controller.enqueue(frame);
  }

  /**
   * Transforms an incoming media stream frame (Decrypt)
   */
  async decryptTransform(frame, controller) {
    if (!this.cryptoKey) {
      controller.enqueue(frame);
      return;
    }

    const data = new Uint8Array(frame.data);
    if (data.byteLength <= 12) {
      controller.enqueue(frame);
      return;
    }

    const iv = data.slice(data.byteLength - 12);
    const ciphertext = data.slice(0, data.byteLength - 12);

    try {
      const decrypted = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        this.cryptoKey,
        ciphertext
      );
      frame.data = decrypted;
      controller.enqueue(frame);
    } catch (err) {
      console.error("Frame decryption failed. Payload dropped.", err);
      // Dropping frame if decryption fails prevents rendering corrupt media
    }
  }

  /**
   * Attach E2EE streams to an RTCRtpSender or RTCRtpReceiver
   */
  setupSenderTransform(sender) {
    const streams = sender.createEncodedStreams();
    const transformStream = new TransformStream({
      transform: (frame, controller) => this.encryptTransform(frame, controller),
    });
    streams.readable.pipeThrough(transformStream).pipeTo(streams.writable);
  }

  setupReceiverTransform(receiver) {
    const streams = receiver.createEncodedStreams();
    const transformStream = new TransformStream({
      transform: (frame, controller) => this.decryptTransform(frame, controller),
    });
    streams.readable.pipeThrough(transformStream).pipeTo(streams.writable);
  }
}
