// Tests for hammingDistance in hash.js using Node's built-in test runner.
// We stub minimal DOM/chrome globals so the script can execute.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// --- Minimal stubs to satisfy hash.js bootstrapping ---
globalThis.window = {};

// Fake canvas context with only the methods hash.js touches during load.
const fakeCtx = {
    getImageData: () => ({ data: [] }),
    clearRect: () => {},
    drawImage: () => {}
};

globalThis.document = {
    createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => fakeCtx
    })
};

// Stub chrome runtime for fetchImageViaBackground (not exercised in tests).
globalThis.chrome = {
    runtime: {
        sendMessage: (_msg, cb) => cb({ success: false })
    }
};

// Minimal Image stub used by loadImage (also not exercised in these tests).
globalThis.Image = class {
    constructor() {
        this.onload = null;
        this.onerror = null;
    }
    set src(_v) {
        // Immediately trigger onload for safety.
        if (typeof this.onload === 'function') this.onload();
    }
};

// Load and execute hash.js in this sandbox so window.ThumbHash is populated.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hashJsPath = path.resolve(__dirname, '../duplicate-thumbnail-highlighter/hash.js');
const hashSource = fs.readFileSync(hashJsPath, 'utf8');
vm.runInThisContext(hashSource, { filename: hashJsPath });

const { hammingDistance } = globalThis.window.ThumbHash;

test('hammingDistance returns 0 for identical hashes', () => {
    assert.equal(hammingDistance('abc123', 'abc123'), 0);
});

test('hammingDistance counts differing bits between hex strings', () => {
    // 0x0 ^ 0x1 has 1 bit difference; 0x0 ^ 0xf has 4 bits difference.
    assert.equal(hammingDistance('0', '1'), 1);
    assert.equal(hammingDistance('0', 'f'), 4);
    assert.equal(hammingDistance('0f', 'f0'), 8);
});

test('hammingDistance handles longer strings and symmetry', () => {
    const a = '0123456789abcdef';
    const b = 'f0123456789abcde';
    assert.equal(hammingDistance(a, b), hammingDistance(b, a));
});

test('hammingDistance returns Infinity on length mismatch', () => {
    assert.equal(hammingDistance('abc', 'ab'), Infinity);
});

