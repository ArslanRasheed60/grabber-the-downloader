'use strict';

// Invoked by the opt-in release job only after every platform build succeeds.
// Without --publish, validate and stage files without changing GitHub.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable semantic version is required');
const tag = `v${version}`;
const source = path.join(root, 'release-assets');
const stage = path.join(root, 'release-publish');
const expected = [
  `Grabber-${version}-win-x64.exe`,
  `Grabber-${version}-mac-arm64.dmg`,
  `Grabber-${version}-mac-arm64.zip`,
  `Grabber-${version}-mac-x64.dmg`,
  `Grabber-${version}-mac-x64.zip`,
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
  });
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function gh(args) {
  return execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024 });
}

async function main() {
  const files = walk(source);
  fs.mkdirSync(stage, { recursive: true });
  const manifest = [];
  for (const name of expected) {
    const matches = files.filter((file) => path.basename(file) === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one build for ${name}`);
    if (fs.statSync(matches[0]).size < 1024 * 1024) throw new Error(`Build is unexpectedly small: ${name}`);
    const destination = path.join(stage, name);
    fs.copyFileSync(matches[0], destination);
    manifest.push({ name, path: destination, size: fs.statSync(destination).size, hash: await sha256(destination) });
  }
  const sums = path.join(stage, 'SHA256SUMS.txt');
  fs.writeFileSync(sums, manifest.map((file) => `${file.hash}  ${file.name}\n`).join(''));
  manifest.push({ name: 'SHA256SUMS.txt', path: sums, size: fs.statSync(sums).size, hash: await sha256(sums) });
  console.log(`Validated ${expected.length} installers for ${tag}`);
  if (!process.argv.includes('--publish')) return;

  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  const commit = process.env.GITHUB_SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[a-f0-9]{40}$/.test(commit || '')) {
    throw new Error('Publishing requires an explicit repository and source commit');
  }
  const releases = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`]));
  if (releases.some((release) => release.tag_name === tag)) throw new Error(`${tag} already exists; choose the next version`);
  gh(['release', 'create', tag, ...manifest.map((file) => file.path), '--repo', repo,
    '--draft', '--target', commit, '--title', `Grabber ${version}`, '--notes-file', path.join(root, 'RELEASE_NOTES.md')]);
  const draft = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`])).find((release) => release.tag_name === tag);
  if (!draft || !draft.draft || draft.target_commitish !== commit || draft.assets.length !== manifest.length) {
    throw new Error('Draft release does not match the intended build');
  }
  for (const file of manifest) {
    const asset = draft.assets.find((item) => item.name === file.name);
    if (!asset || asset.state !== 'uploaded' || asset.size !== file.size || asset.digest !== `sha256:${file.hash}`) {
      throw new Error(`Uploaded checksum/size mismatch: ${file.name}`);
    }
  }
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
  console.log(`Published https://github.com/${repo}/releases/tag/${tag}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
