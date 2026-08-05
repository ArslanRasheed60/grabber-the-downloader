'use strict';

/**
 * electron-builder afterPack hook.
 *
 * Apple Silicon refuses to launch an arm64 binary that carries no signature at all,
 * so an unsigned build is not merely "untrusted" — it does not start. When no real
 * signing identity is configured, ad-hoc sign the bundle so the app runs after a
 * right-click → Open. A real Developer ID, if present, takes over instead.
 */

const path = require('path');
const { execFile } = require('child_process');

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') {
    console.log('  • skipping ad-hoc signing — codesign only exists on macOS');
    return;
  }
  // A real certificate is configured; let electron-builder do its normal signing.
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_IDENTITY) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`  • ad-hoc signing ${appName}`);
  await run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
  await run('codesign', ['--verify', '--verbose=2', appPath]).catch((err) => {
    console.warn(`  • signature check reported: ${err.message.trim()}`);
  });
};
