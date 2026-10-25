// Stand-in for Electron safeStorage in tests. Encryption is reversible but never plain text
// (each byte is XOR-ed and the result is tagged), so tests can prove keys are not stored readably.
// Switches: `available` (OS encryption present), `backend` ('basic_text' = Linux plaintext store),
// `failDecrypt` (e.g. data encrypted for another Windows user).
const TAG = Buffer.from('FAKE-DPAPI:');

export function createFakeSafeStorage({ available = true, backend = 'dpapi', failDecrypt = false } = {}) {
  const fake = {
    available,
    backend,
    failDecrypt,
    calls: { encrypt: 0, decrypt: 0 },
    isEncryptionAvailable: () => fake.available,
    getSelectedStorageBackend: () => fake.backend,
    encryptString(text) {
      if (!fake.available) throw new Error('Encryption is not available.');
      fake.calls.encrypt += 1;
      const body = Buffer.from(String(text), 'utf8').map((byte) => byte ^ 0x5a);
      return Buffer.concat([TAG, body]);
    },
    decryptString(buffer) {
      fake.calls.decrypt += 1;
      if (fake.failDecrypt || !Buffer.isBuffer(buffer) || !buffer.subarray(0, TAG.length).equals(TAG)) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      }
      return Buffer.from(buffer.subarray(TAG.length).map((byte) => byte ^ 0x5a)).toString('utf8');
    },
  };
  return fake;
}

/** A syntactically valid Anthropic-format test key (not a real credential). */
export const TEST_KEY = 'sk-ant-test-0123456789abcdefghijKLMNOP';
export const OTHER_TEST_KEY = 'sk-ant-test-ZYXWVUTSRQponmlkjihgfedcba98';
