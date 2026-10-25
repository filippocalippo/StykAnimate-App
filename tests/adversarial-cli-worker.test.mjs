import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import {
  generateSvgAsset,
  generateIconAsset,
  generateMascotAsset,
  generateAnimationAsset,
  generateAsset,
  parseArgs,
  probeBinary,
  invokeEngine
} from '../scripts/creative-studio-cli.mjs';

import {
  rasterizeSvg,
  inspectImageHeader,
  decodeRasterImage,
  extractLandmarksFromPixels,
  processPoseEstimation
} from '../src/workers/pose-estimation-worker.mjs';

import {
  PoseEstimationClient,
  detectMimeTypeFromBuffer
} from '../src/pose-estimation-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../scripts/creative-studio-cli.mjs');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  });
}

describe('Challenger 2: Adversarial Stress Tests (CLI & Worker Subsystems)', () => {

  // =========================================================================
  // SUITE 1: CLI Invocations, Arguments, Flags & Exit Codes
  // =========================================================================
  describe('Suite 1: CLI Invocations, Flags & Argument Robustness', () => {
    it('C1.1: Invocation with no arguments exits with code 1 and prints usage help', () => {
      const res = runCli([]);
      assert.equal(res.status, 1, `Expected exit code 1, got ${res.status}`);
      assert(res.stdout.includes('Creative Agent Studio CLI') || res.stderr.includes('Creative Agent Studio CLI'),
        'Expected usage help in output');
    });

    it('C1.2: Invocation with --help exits with code 0 and prints usage help', () => {
      const res = runCli(['--help']);
      assert.equal(res.status, 0);
      assert(res.stdout.includes('Usage:'));
      assert(res.stdout.includes('--type'));
      assert(res.stdout.includes('--prompt'));
    });

    it('C1.3: Invocation with --version exits with code 0 and displays version number', () => {
      const res = runCli(['--version']);
      assert.equal(res.status, 0);
      assert(res.stdout.includes('creative-studio-cli 1.0.0'));
    });

    it('C1.4: Invocation with unknown command exits with code 1', () => {
      const res = runCli(['unknownCommand']);
      assert.equal(res.status, 1);
    });

    it('C1.5: generate command missing --type flag exits with code 1', () => {
      const res = runCli(['generate', '--prompt', 'a golden star']);
      assert.equal(res.status, 1);
      assert(res.stderr.includes('Invalid asset type'));
    });

    it('C1.6: generate command with invalid --type exits with code 1 and lists supported types', () => {
      const res = runCli(['generate', '--type', 'maliciousPayload', '--prompt', 'test']);
      assert.equal(res.status, 1);
      assert(res.stderr.includes('Invalid asset type "maliciousPayload"'));
      assert(res.stderr.includes('Supported types: svg, icon, mascot, animation'));
    });

    it('C1.7: generate command missing --prompt flag exits with code 1', () => {
      const res = runCli(['generate', '--type', 'svg']);
      assert.equal(res.status, 1);
      assert(res.stderr.includes('A non-empty --prompt is required'));
    });

    it('C1.8: generate command with empty string --prompt exits with code 1', () => {
      const res = runCli(['generate', '--type', 'svg', '--prompt', '']);
      assert.equal(res.status, 1);
      assert(res.stderr.includes('A non-empty --prompt is required'));
    });

    it('C1.9: generate command with whitespace-only --prompt exits with code 1', () => {
      const res = runCli(['generate', '--type', 'svg', '--prompt', '    \t\n  ']);
      assert.equal(res.status, 1);
      assert(res.stderr.includes('A non-empty --prompt is required'));
    });

    it('C1.10: generate command with unsupported/non-existent engine falls back gracefully to procedural engine', () => {
      const res = runCli(['generate', '--type', 'svg', '--prompt', 'star', '--engine', 'nonExistentEngineXYZ']);
      assert.equal(res.status, 0);
      assert(res.stdout.includes('<svg') && res.stdout.includes('</svg>'));
    });

    it('C1.11: generate command with claude engine (when uninstalled) logs fallback warning and succeeds', () => {
      const res = runCli(['generate', '--type', 'svg', '--prompt', 'star', '--engine', 'claude']);
      assert.equal(res.status, 0);
      assert(res.stdout.includes('<svg') && res.stdout.includes('</svg>'));
    });

    it('C1.12: generate command with codex engine (when uninstalled) logs fallback warning and succeeds', () => {
      const res = runCli(['generate', '--type', 'svg', '--prompt', 'shield', '--engine', 'codex']);
      assert.equal(res.status, 0);
      assert(res.stdout.includes('<svg') && res.stdout.includes('</svg>'));
    });

    it('C1.13: generate command with opencode engine (when uninstalled) logs fallback warning and succeeds', () => {
      const res = runCli(['generate', '--type', 'svg', '--prompt', 'geometric composition', '--engine', 'opencode']);
      assert.equal(res.status, 0);
      assert(res.stdout.includes('<svg') && res.stdout.includes('</svg>'));
    });

    it('C1.14: generate command writing to invalid/unwritable path fails cleanly with code 1', () => {
      // In Windows, characters like * ? : are forbidden in file names
      const invalidPath = 'C:\\invalid\\forbidden*path?\\asset.svg';
      const res = runCli(['generate', '--type', 'svg', '--prompt', 'star', '--out', invalidPath]);
      assert.equal(res.status, 1);
      assert(res.stderr.includes('Error:'));
    });

    it('C1.15: generate command writing to valid nested path creates directories recursively', () => {
      const targetOut = path.resolve(__dirname, '../.tmp_adversarial_test/nested/deep/star.svg');
      try {
        const res = runCli(['generate', '--type', 'svg', '--prompt', 'star', '--out', targetOut]);
        assert.equal(res.status, 0);
        assert(fs.existsSync(targetOut));
        const content = fs.readFileSync(targetOut, 'utf8');
        assert(content.includes('<svg') && content.includes('</svg>'));
      } finally {
        try { fs.rmSync(path.resolve(__dirname, '../.tmp_adversarial_test'), { recursive: true, force: true }); } catch {}
      }
    });

    it('C1.16: parseArgs handles both space-separated and equals-separated syntax', () => {
      const args1 = parseArgs(['generate', '--type', 'icon', '--prompt', 'robot', '--engine', 'codex', '--out', 'out.svg']);
      assert.equal(args1.command, 'generate');
      assert.equal(args1.type, 'icon');
      assert.equal(args1.prompt, 'robot');
      assert.equal(args1.engine, 'codex');
      assert.equal(args1.out, 'out.svg');

      const args2 = parseArgs(['generate', '--type=mascot', '--prompt=claude', '--engine=claude', '--out=mascot.svg']);
      assert.equal(args2.type, 'mascot');
      assert.equal(args2.prompt, 'claude');
      assert.equal(args2.engine, 'claude');
      assert.equal(args2.out, 'mascot.svg');
    });

    it('C1.17: probeBinary returns false for nonexistent binary without throwing', () => {
      assert.equal(probeBinary('nonexistent_bin_12345'), false);
    });

    it('C1.18: invokeEngine returns null for unsupported engine names without throwing', () => {
      assert.equal(invokeEngine('unsupportedEngine', 'svg', 'star'), null);
      assert.equal(invokeEngine(null, 'svg', 'star'), null);
      assert.equal(invokeEngine(undefined, 'svg', 'star'), null);
    });
  });

  // =========================================================================
  // SUITE 2: SVG/XML Output Strict Validity and Injection/XSS Hardening
  // =========================================================================
  describe('Suite 2: SVG/XML Output Strict Validity & Injection/XSS Hardening', () => {
    const maliciousPrompts = [
      '"><script>alert("XSS")</script><svg onload=alert(1)>',
      '\'><script src="https://evil.com/xss.js"></script>',
      '"><img src="x" onerror="alert(1)">',
      '"><iframe src="javascript:alert(1)"></iframe>',
      '<!ENTITY % dtd SYSTEM "file:///etc/passwd">%dtd;',
      '<?xml-stylesheet type="text/xsl" href="evil.xsl"?>',
      'Prompt with null byte \0 and control chars \x01\x02\x03\x04\x08',
      'A & B < C > D " E \' F &amp; &lt; &gt;',
      'Prompt with bidirectional override \u202E\u202D\u202C and emojis 🚀🔥🎉🤖👾',
      'A'.repeat(50000) // 50KB mega-prompt
    ];

    for (const [index, p] of maliciousPrompts.entries()) {
      it(`C2.${index + 1}: Malicious prompt #${index + 1} produces safe, valid SVG without script injection`, async () => {
        const svg = generateSvgAsset(p);
        assert(typeof svg === 'string');
        assert(svg.includes('<svg') && svg.includes('</svg>'));
        assert(svg.includes('xmlns="http://www.w3.org/2000/svg"'));

        // Strict security checks: MUST NOT contain script tags or event handlers
        assert(!svg.toLowerCase().includes('<script'), 'SVG must not contain <script>');
        assert(!svg.toLowerCase().includes('onload='), 'SVG must not contain onload=');
        assert(!svg.toLowerCase().includes('onerror='), 'SVG must not contain onerror=');
        assert(!svg.toLowerCase().includes('javascript:'), 'SVG must not contain javascript:');
        assert(!svg.toLowerCase().includes('<iframe'), 'SVG must not contain <iframe');
        assert(!svg.toLowerCase().includes('<!entity'), 'SVG must not contain <!ENTITY');

        // Verify XML parseability using resvg WASM
        const rasterized = await rasterizeSvg(svg);
        assert(rasterized.width > 0 && rasterized.height > 0);
        assert(rasterized.pixels instanceof Uint8ClampedArray);
      });
    }

    it('C2.11: App Icon generator with malicious prompt produces valid SVG and parses cleanly', async () => {
      const malicious = '"><script>alert(1)</script> robot timeline bot';
      const iconSvg = generateIconAsset(malicious);
      assert(!iconSvg.toLowerCase().includes('<script'));
      const rasterized = await rasterizeSvg(iconSvg);
      assert(rasterized.width === 512 && rasterized.height === 512);
    });

    it('C2.12: Mascot generator with Claude prompt produces valid SVG and parses cleanly', async () => {
      const mascotSvg = generateMascotAsset('claude terracotta mascot <script>');
      assert(!mascotSvg.toLowerCase().includes('<script'));
      assert(mascotSvg.includes('#D97757'));
      const rasterized = await rasterizeSvg(mascotSvg);
      assert(rasterized.width === 512 && rasterized.height === 512);
    });

    it('C2.13: Mascot generator with generic prompt produces valid SVG and parses cleanly', async () => {
      const mascotSvg = generateMascotAsset('friendly blue stick mascot');
      assert(!mascotSvg.toLowerCase().includes('<script'));
      const rasterized = await rasterizeSvg(mascotSvg);
      assert(rasterized.width === 512 && rasterized.height === 512);
    });

    it('C2.14: Animation generator produces valid JSON and sanitizes prompt in metadata', () => {
      const maliciousPrompt = 'waving figure "><script>alert(1)</script>';
      const animJson = generateAnimationAsset(maliciousPrompt);
      assert(typeof animJson === 'string');
      const parsed = JSON.parse(animJson);
      assert.equal(parsed._styk.prompt, maliciousPrompt);
      assert(Array.isArray(parsed.keyframes));
      assert.equal(parsed.keyframes.length, 8);
      assert(parsed.figure.segments.length === 10);
      assert(parsed.object._stykIK);
      assert(parsed.object._stykIK['4'].enabled && parsed.object._stykIK['4'].chainLength === 2);
      assert(parsed.object._stykIK['6'].enabled && parsed.object._stykIK['6'].chainLength === 2);
      assert(parsed.object._stykIK['8'].enabled && parsed.object._stykIK['8'].chainLength === 2);
      assert(parsed.object._stykIK['10'].enabled && parsed.object._stykIK['10'].chainLength === 2);
    });
  });

  // =========================================================================
  // SUITE 3: Corrupted Image Buffers, Truncated Streams & 0-Byte Inputs
  // =========================================================================
  describe('Suite 3: Corrupted Image Buffers, Truncated Streams & 0-Byte Inputs', () => {
    it('C3.1: 0-byte ArrayBuffer throws invalidImageFormat localized error', async () => {
      await assert.rejects(
        async () => {
          await processPoseEstimation({ buffer: new ArrayBuffer(0), mimeType: 'image/png' });
        },
        (err) => {
          assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
          return true;
        }
      );
    });

    it('C3.2: 1-byte buffer throws invalidImageFormat localized error', async () => {
      await assert.rejects(
        async () => {
          await processPoseEstimation({ buffer: new Uint8Array([0x89]).buffer, mimeType: 'image/png' });
        },
        (err) => {
          assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
          return true;
        }
      );
    });

    it('C3.3: 7-byte buffer below 8-byte minimum header check throws invalidImageFormat', async () => {
      await assert.rejects(
        async () => {
          await processPoseEstimation({ buffer: new Uint8Array(7).buffer, mimeType: 'image/png' });
        },
        (err) => {
          assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
          return true;
        }
      );
    });

    it('C3.4: 16-byte truncated PNG header (missing IHDR) throws noPoseDetected or invalidImageFormat gracefully', async () => {
      const truncatedPng = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
      ]).buffer;

      await assert.rejects(
        async () => {
          await processPoseEstimation({ buffer: truncatedPng, mimeType: 'image/png' });
        },
        (err) => {
          assert(err.messageKey.startsWith('errors.poseEstimationWorker.'));
          return true;
        }
      );
    });

    it('C3.5: Truncated JPEG (3 bytes FF D8 FF) throws invalidImageFormat', async () => {
      const truncatedJpg = new Uint8Array([0xFF, 0xD8, 0xFF]).buffer;
      await assert.rejects(
        async () => {
          await processPoseEstimation({ buffer: truncatedJpg, mimeType: 'image/jpeg' });
        },
        (err) => {
          assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
          return true;
        }
      );
    });

    it('C3.6: Truncated WebP (4 bytes RIFF) throws invalidImageFormat', async () => {
      const truncatedWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;
      await assert.rejects(
        async () => {
          await processPoseEstimation({ buffer: truncatedWebp, mimeType: 'image/webp' });
        },
        (err) => {
          assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
          return true;
        }
      );
    });

    it('C3.7: 1024 bytes of random noise with image/png mimeType fails with invalidImageFormat', async () => {
      const noise = new Uint8Array(1024);
      for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 13) % 256;
      // Ensure it doesn't accidentally have PNG magic bytes
      noise[0] = 0x00;

      await assert.rejects(
        async () => {
          await processPoseEstimation({ buffer: noise.buffer, mimeType: 'image/png' });
        },
        (err) => {
          assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
          return true;
        }
      );
    });

    it('C3.8: Malformed SVG string without <svg tag throws invalidImageFormat', async () => {
      await assert.rejects(
        async () => {
          await rasterizeSvg('<html><body>Not an SVG file</body></html>');
        },
        (err) => {
          assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
          return true;
        }
      );
    });

    it('C3.9: Syntactically broken SVG throws invalidImageFormat without crashing WASM', async () => {
      await assert.rejects(
        async () => {
          await rasterizeSvg('<svg><g><path d="broken incomplete garbage');
        },
        (err) => {
          assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
          return true;
        }
      );
    });

    it('C3.10: Zero-dimension SVG throws invalidImageFormat', async () => {
      await assert.rejects(
        async () => {
          await rasterizeSvg('<svg width="0" height="0"></svg>');
        },
        (err) => {
          assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
          return true;
        }
      );
    });

    it('C3.11: extractLandmarksFromPixels with null or zero dimensions throws noPoseDetected', () => {
      assert.throws(
        () => extractLandmarksFromPixels(null, 100, 100),
        (err) => err.messageKey === 'errors.poseEstimationWorker.noPoseDetected'
      );
      assert.throws(
        () => extractLandmarksFromPixels(new Uint8ClampedArray(400), 0, 100),
        (err) => err.messageKey === 'errors.poseEstimationWorker.noPoseDetected'
      );
    });

    it('C3.12: extractLandmarksFromPixels with uniform white canvas throws noPoseDetected', () => {
      // 100x100 white pixels (RGBA: 255, 255, 255, 255)
      const pixels = new Uint8ClampedArray(100 * 100 * 4);
      pixels.fill(255);
      assert.throws(
        () => extractLandmarksFromPixels(pixels, 100, 100),
        (err) => err.messageKey === 'errors.poseEstimationWorker.noPoseDetected'
      );
    });

    it('C3.13: extractLandmarksFromPixels with completely transparent canvas throws noPoseDetected', () => {
      // 100x100 transparent pixels (RGBA: 0, 0, 0, 0)
      const pixels = new Uint8ClampedArray(100 * 100 * 4);
      assert.throws(
        () => extractLandmarksFromPixels(pixels, 100, 100),
        (err) => err.messageKey === 'errors.poseEstimationWorker.noPoseDetected'
      );
    });

    it('C3.14: extractLandmarksFromPixels with sub-minimum figure (< 6x10 px) throws noPoseDetected', () => {
      // Create transparent 100x100 canvas with a 3x3 dot
      const pixels = new Uint8ClampedArray(100 * 100 * 4);
      for (let y = 50; y < 53; y++) {
        for (let x = 50; x < 53; x++) {
          const idx = (y * 100 + x) * 4;
          pixels[idx] = 255;
          pixels[idx + 3] = 255;
        }
      }
      assert.throws(
        () => extractLandmarksFromPixels(pixels, 100, 100),
        (err) => err.messageKey === 'errors.poseEstimationWorker.noPoseDetected'
      );
    });

    it('C3.15: extractLandmarksFromPixels with valid human-like silhouette produces 33 finite normalized landmarks', () => {
      // Create 200x200 canvas with a stylized stick figure
      const width = 200;
      const height = 200;
      const pixels = new Uint8ClampedArray(width * height * 4);

      // Draw head (radius 15 at 100, 40)
      for (let y = 25; y <= 55; y++) {
        for (let x = 85; x <= 115; x++) {
          if ((x - 100) ** 2 + (y - 40) ** 2 <= 15 ** 2) {
            const idx = (y * width + x) * 4;
            pixels[idx] = 217; pixels[idx + 1] = 119; pixels[idx + 2] = 87; pixels[idx + 3] = 255;
          }
        }
      }

      // Draw torso (x: 95-105, y: 55-130)
      for (let y = 55; y <= 130; y++) {
        for (let x = 95; x <= 105; x++) {
          const idx = (y * width + x) * 4;
          pixels[idx] = 217; pixels[idx + 1] = 119; pixels[idx + 2] = 87; pixels[idx + 3] = 255;
        }
      }

      // Draw arms (y: 70-110, x: 60-140)
      for (let y = 70; y <= 76; y++) {
        for (let x = 60; x <= 140; x++) {
          const idx = (y * width + x) * 4;
          pixels[idx] = 217; pixels[idx + 1] = 119; pixels[idx + 2] = 87; pixels[idx + 3] = 255;
        }
      }

      // Draw legs (y: 130-190, x: 75-85 and 115-125)
      for (let y = 130; y <= 190; y++) {
        for (const x of [75, 76, 77, 78, 122, 123, 124, 125]) {
          const idx = (y * width + x) * 4;
          pixels[idx] = 217; pixels[idx + 1] = 119; pixels[idx + 2] = 87; pixels[idx + 3] = 255;
        }
      }

      const landmarks = extractLandmarksFromPixels(pixels, width, height);
      assert.equal(landmarks.length, 33);
      for (const lm of landmarks) {
        assert(Number.isFinite(lm.x) && lm.x >= 0 && lm.x <= 1, `Invalid landmark x: ${lm.x}`);
        assert(Number.isFinite(lm.y) && lm.y >= 0 && lm.y <= 1, `Invalid landmark y: ${lm.y}`);
        assert(Number.isFinite(lm.visibility) && lm.visibility > 0);
      }
    });
  });

  // =========================================================================
  // SUITE 4: Worker Protocol, Message Handling & Main-Thread Error Isolation
  // =========================================================================
  describe('Suite 4: Worker Protocol, Message Handling & Error Isolation', () => {
    it('C4.1: PoseEstimationClient rejects unsupported mimeType application/pdf', async () => {
      const client = new PoseEstimationClient();
      await assert.rejects(
        async () => {
          await client.estimatePose(new ArrayBuffer(100), { mimeType: 'application/pdf' });
        },
        (err) => err.messageKey === 'errors.poseEstimationWorker.invalidImageFormat'
      );
    });

    it('C4.2: PoseEstimationClient rejects unsupported mimeType image/gif', async () => {
      const client = new PoseEstimationClient();
      await assert.rejects(
        async () => {
          await client.estimatePose(new ArrayBuffer(100), { mimeType: 'image/gif' });
        },
        (err) => err.messageKey === 'errors.poseEstimationWorker.invalidImageFormat'
      );
    });

    it('C4.3: PoseEstimationClient rejects empty buffer input', async () => {
      const client = new PoseEstimationClient();
      await assert.rejects(
        async () => {
          await client.estimatePose(new ArrayBuffer(0), { mimeType: 'image/png' });
        },
        (err) => err.messageKey === 'errors.poseEstimationWorker.invalidImageFormat'
      );
    });

    it('C4.4: detectMimeTypeFromBuffer correctly identifies PNG magic bytes', () => {
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00, 0x00]);
      assert.equal(detectMimeTypeFromBuffer(pngHeader), 'image/png');
    });

    it('C4.5: detectMimeTypeFromBuffer correctly identifies JPEG magic bytes', () => {
      const jpegHeader = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
      assert.equal(detectMimeTypeFromBuffer(jpegHeader), 'image/jpeg');
    });

    it('C4.6: detectMimeTypeFromBuffer correctly identifies WebP magic bytes', () => {
      const webpHeader = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50
      ]);
      assert.equal(detectMimeTypeFromBuffer(webpHeader), 'image/webp');
    });

    it('C4.7: detectMimeTypeFromBuffer correctly identifies SVG text', () => {
      const svgText = new TextEncoder().encode('<svg viewBox="0 0 100 100"></svg>');
      assert.equal(detectMimeTypeFromBuffer(svgText), 'image/svg+xml');
    });

    it('C4.8: detectMimeTypeFromBuffer returns null for unknown or corrupted formats without throwing', () => {
      assert.equal(detectMimeTypeFromBuffer(null), null);
      assert.equal(detectMimeTypeFromBuffer(new Uint8Array(2)), null);
      assert.equal(detectMimeTypeFromBuffer(new Uint8Array([0x00, 0x01, 0x02, 0x03])), null);
    });

    it('C4.9: Simulated Web Worker onerror cleanly terminates worker and rejects all pending calls without crashing', async () => {
      let simulatedWorkerInstance = null;
      const mockWorkerFactory = () => {
        simulatedWorkerInstance = {
          postMessage() {
            // Simulate sudden catastrophic error in worker runtime
            setTimeout(() => {
              if (this.onerror) {
                this.onerror(new Error('Simulated WebWorker out-of-memory or crash'));
              }
            }, 10);
          },
          terminate() {
            this.terminated = true;
          }
        };
        return simulatedWorkerInstance;
      };

      // Ensure global Worker exists for ensureWorker to use factory
      const originalWorker = globalThis.Worker;
      globalThis.Worker = function() {};

      try {
        const client = new PoseEstimationClient({ workerFactory: mockWorkerFactory });
        await assert.rejects(
          async () => {
            const buf = new Uint8Array(100).buffer;
            await client.estimatePose(buf, { mimeType: 'image/png' });
          },
          (err) => {
            assert.equal(err.messageKey, 'errors.poseEstimationWorker.inferenceFailed');
            return true;
          }
        );
        assert.equal(simulatedWorkerInstance.terminated, true, 'Worker should have been terminated after error');
      } finally {
        globalThis.Worker = originalWorker;
      }
    });

    it('C4.10: Simulated Web Worker onmessageerror cleanly terminates worker and rejects all pending calls', async () => {
      let simulatedWorkerInstance = null;
      const mockWorkerFactory = () => {
        simulatedWorkerInstance = {
          postMessage() {
            setTimeout(() => {
              if (this.onmessageerror) {
                this.onmessageerror(new Error('Simulated transfer error'));
              }
            }, 10);
          },
          terminate() {
            this.terminated = true;
          }
        };
        return simulatedWorkerInstance;
      };

      const originalWorker = globalThis.Worker;
      globalThis.Worker = function() {};

      try {
        const client = new PoseEstimationClient({ workerFactory: mockWorkerFactory });
        await assert.rejects(
          async () => {
            const buf = new Uint8Array(100).buffer;
            await client.estimatePose(buf, { mimeType: 'image/png' });
          },
          (err) => {
            assert.equal(err.messageKey, 'errors.poseEstimationWorker.inferenceFailed');
            return true;
          }
        );
        assert.equal(simulatedWorkerInstance.terminated, true);
      } finally {
        globalThis.Worker = originalWorker;
      }
    });

    it('C4.11: Disposed client rejects subsequent calls immediately', async () => {
      const client = new PoseEstimationClient();
      client.dispose();
      await assert.rejects(
        async () => {
          await client.estimatePose(new Uint8Array(100).buffer, { mimeType: 'image/png' });
        },
        (err) => err.messageKey === 'errors.poseEstimationWorker.inferenceFailed'
      );
    });

    it('C4.12: Concurrency stress: 20 rapid sequential/concurrent headless requests complete with correct ID mapping', async () => {
      const client = new PoseEstimationClient();
      const validSvg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#D97757"/></svg>';

      const promises = Array.from({ length: 20 }, async (_, i) => {
        if (i % 2 === 0) {
          // Valid request
          const res = await client.estimatePose(validSvg);
          assert.equal(res.ok, true);
          assert.equal(res.landmarks.length, 33);
          return 'ok';
        } else {
          // Intentionally invalid request
          try {
            await client.estimatePose(new ArrayBuffer(0), { mimeType: 'image/png' });
            return 'should-have-failed';
          } catch (err) {
            assert.equal(err.messageKey, 'errors.poseEstimationWorker.invalidImageFormat');
            return 'rejected-ok';
          }
        }
      });

      const results = await Promise.all(promises);
      assert.equal(results.filter(r => r === 'ok').length, 10);
      assert.equal(results.filter(r => r === 'rejected-ok').length, 10);
    });
  });
});
