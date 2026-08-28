// Build-and-archive pipeline used by both `appliance build` and the
// auto-build path inside `appliance deploy`. Factored out so the two
// stay in lockstep without spawning a child Node process.
//
// An appliance.zip is SOURCE, not an image: manifest + project tree.
// Images are built server-side by the api-server (BuildKit against
// the base's builder) — the CLI needs no docker/buildctl/crane.
//
//   1. Run any user `scripts.build` (platform shell).
//   2. Open a zip stream at `outputPath`.
//   3. Write the resolved manifest (sans per-env runtime overrides).
//   4. Type-specific packaging:
//      - container : glob the project tree (Dockerfile + source),
//        honoring .dockerignore.
//      - framework : glob the project tree; for Lambda targets only,
//        additionally pre-install deps + generate `run.sh` (the Lambda
//        zip runtime executes the tree as-is — no image build there).
//      - other     : glob the project tree as-is.
//   5. Finalize the zip and return its on-disk size.
//
// All console output remains chalk-coloured to match the rest of the
// CLI; deploy's auto-build path calls this directly so the user sees
// one continuous log.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import archiver from 'archiver';
import chalk from 'chalk';
import { ApplianceType } from '@appliance.sh/sdk';
import type { ApplianceFullInput, ApplianceV2, ApplianceV2Service } from '@appliance.sh/sdk';
import { verifyBundle } from './bundle-read.js';
import { writeBundle, type BundleFileInput, type WriteBundleResult } from './bundle-write.js';

export interface BuildResult {
  outputPath: string;
  sizeBytes: number;
}

export interface BuildOptions {
  appliance: ApplianceFullInput;
  outputPath: string;
  /**
   * Prepare framework apps for the Lambda zip runtime (host-side
   * dependency install + run.sh). Only the cloud/Lambda base consumes
   * zips this way; container-runtime bases build an image from the
   * source server-side and ignore the prep. Defaults to true so a
   * standalone `appliance build` artifact deploys anywhere.
   */
  lambdaPrep?: boolean;
}

export interface RunnablePackageOptions {
  manifest: ApplianceV2;
  projectDir: string;
  outputPath: string;
  signingKeyPath?: string;
  /**
   * A selector can be `linux/amd64=<tar-or-ref>`,
   * `<payload/image/path>=<tar-or-ref>`, or a bare value when the manifest
   * contains exactly one image.
   */
  images?: string[];
}

const PYTHON_VENV_DIR = '.venv';
const ALWAYS_EXCLUDES = ['.git/**', '.env', '.env.*', 'appliance.zip', '*.tar'];

export async function buildApplianceZip(opts: BuildOptions): Promise<BuildResult> {
  const { appliance, outputPath, lambdaPrep = true } = opts;

  if (appliance.scripts?.build) {
    console.log(chalk.dim(`Running build: ${appliance.scripts.build}`));
    try {
      // Platform shell (`cmd.exe` on Windows, `/bin/sh` elsewhere) —
      // the script is the user's own contract with their machine.
      execSync(appliance.scripts.build, { stdio: 'inherit' });
    } catch {
      throw new Error('Build script failed.');
    }
  }

  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });

  archive.pipe(output);

  // Strip per-environment runtime config from the archived manifest;
  // those fields are re-rendered per deploy and forwarded via the
  // deploy payload instead. Keeps a build artifact reusable across
  // environments.
  const {
    env: _env,
    memory: _memory,
    timeout: _timeout,
    storage: _storage,
    ...manifestForZip
  } = appliance as typeof appliance & { memory?: number; timeout?: number; storage?: number };
  archive.append(JSON.stringify(manifestForZip, null, 2), { name: 'appliance.json' });

  if (appliance.type === ApplianceType.container) {
    packageContainerSource(archive);
  } else if (appliance.type === ApplianceType.framework) {
    packageFramework(archive, appliance, lambdaPrep);
  } else {
    packageBundle(archive);
  }

  await archive.finalize();
  await done;

  const stats = fs.statSync(outputPath);
  return { outputPath, sizeBytes: stats.size };
}

/** Build/copy v2 payload leaves, then write one runnable bundle. */
export async function packageRunnableAppliance(options: RunnablePackageOptions): Promise<WriteBundleResult> {
  const projectDir = path.resolve(options.projectDir);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-package-'));
  const files: BundleFileInput[] = [];
  const imageLeaves = collectImageLeaves(options.manifest);
  const selectedImages = resolveImageSelections(options.images ?? [], imageLeaves);

  try {
    for (const leaf of imageLeaves) {
      const selected = selectedImages.get(leaf.path);
      const staged = path.join(stagingDir, `${files.length}.oci.tar`);
      if (selected) {
        if (isImageTarPath(selected)) {
          const localPath = path.resolve(projectDir, selected);
          if (!fs.existsSync(localPath)) throw new Error(`image tar not found: ${selected}`);
          const stat = fs.lstatSync(localPath);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error(`--image tar must be a regular file: ${selected}`);
          files.push({ path: leaf.path, sourcePath: localPath });
        } else {
          buildOciTar(projectDir, leaf.platform, staged, selected);
          files.push({ path: leaf.path, sourcePath: staged });
        }
      } else {
        if (options.manifest.type === 'compound') {
          throw new Error(
            `Compound container leaf ${leaf.path} needs --image ${leaf.platform}=<ref-or-tar>; ` +
              'compound manifests do not declare per-leaf build contexts.'
          );
        }
        buildOciTar(projectDir, leaf.platform, staged);
        files.push({ path: leaf.path, sourcePath: staged });
      }
    }

    collectBinaryPayloads(options.manifest, projectDir, files);
    collectAssets(options.manifest, projectDir, files);
    const result = await writeBundle({
      outputPath: options.outputPath,
      manifest: options.manifest,
      files,
      signingKeyPath: options.signingKeyPath,
    });
    verifyBundle(result.outputPath);
    return result;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function isImageTarPath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.endsWith('.tar');
}

interface ImageLeaf {
  platform: string;
  path: string;
}

function collectImageLeaves(manifest: ApplianceV2): ImageLeaf[] {
  const leaves: ImageLeaf[] = [];
  const visit = (node: ApplianceV2 | ApplianceV2Service) => {
    if (node.type === 'container') {
      for (const [platform, image] of Object.entries(node.payload.images)) {
        leaves.push({ platform, path: image.path });
      }
    } else if (node.type === 'compound') {
      for (const service of Object.values(node.services)) visit(service);
    }
  };
  visit(manifest);
  return leaves;
}

function resolveImageSelections(values: string[], leaves: ImageLeaf[]): Map<string, string> {
  const selected = new Map<string, string>();
  for (const value of values) {
    const equals = value.indexOf('=');
    if (equals < 0) {
      if (leaves.length !== 1) throw new Error('A bare --image value requires exactly one image in the manifest.');
      selected.set(leaves[0].path, value);
      continue;
    }
    const selector = value.slice(0, equals);
    const image = value.slice(equals + 1);
    if (!image) throw new Error(`--image has no ref or tar path: ${value}`);
    const byPath = leaves.filter((leaf) => leaf.path === selector);
    const matches = byPath.length > 0 ? byPath : leaves.filter((leaf) => leaf.platform === selector);
    if (matches.length === 0) throw new Error(`--image selector does not match the manifest: ${selector}`);
    if (matches.length > 1) {
      throw new Error(`--image selector ${selector} is ambiguous; select the full payload image path instead.`);
    }
    selected.set(matches[0].path, image);
  }
  return selected;
}

function buildOciTar(projectDir: string, platform: string, destination: string, imageRef?: string): void {
  const args = ['buildx', 'build', '--platform', platform, '--output', `type=oci,dest=${destination}`];
  let input: string | undefined;
  if (imageRef) {
    args.push('--file', '-', projectDir);
    input = `FROM ${imageRef}\n`;
    console.log(chalk.dim(`Exporting ${imageRef} for ${platform} as an OCI image tar.`));
  } else {
    if (!fs.existsSync(path.join(projectDir, 'Dockerfile'))) {
      throw new Error('Container runnable packaging needs a Dockerfile or --image <ref-or-tar>.');
    }
    args.push(projectDir);
    console.log(chalk.dim(`Building ${platform} as an OCI image tar with the local Docker/buildkit engine.`));
  }
  try {
    execFileSync('docker', args, {
      cwd: projectDir,
      input,
      stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new Error('docker is not installed or not on PATH');
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OCI image build failed for ${platform}: ${detail}. Start a local Docker/buildkit engine, ` +
        `or pass --image ${platform}=<prebuilt-ref-or-tar>.`
    );
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function collectBinaryPayloads(manifest: ApplianceV2, projectDir: string, files: BundleFileInput[]): void {
  const roots = new Set<string>();
  const visit = (node: ApplianceV2 | ApplianceV2Service) => {
    if (node.type === 'binary') {
      for (const target of Object.values(node.payload.targets)) {
        if (!roots.has(target.root)) {
          roots.add(target.root);
          addDirectoryFiles(projectDir, target.root, files);
        }
        const entrypoint = path.join(projectDir, ...target.root.split('/'), ...target.entrypoint.split('/'));
        if (!fs.existsSync(entrypoint) || !fs.lstatSync(entrypoint).isFile()) {
          throw new Error(`Binary entrypoint is missing or not a regular file: ${target.root}/${target.entrypoint}`);
        }
      }
    } else if (node.type === 'compound') {
      for (const service of Object.values(node.services)) visit(service);
    }
  };
  visit(manifest);
}

function collectAssets(manifest: ApplianceV2, projectDir: string, files: BundleFileInput[]): void {
  for (const asset of [manifest.assets?.icon, manifest.assets?.readme]) {
    if (!asset) continue;
    const sourcePath = path.join(projectDir, ...asset.split('/'));
    if (!fs.existsSync(sourcePath) || !fs.lstatSync(sourcePath).isFile()) {
      throw new Error(`Manifest asset is missing or not a regular file: ${asset}`);
    }
    files.push({ path: asset, sourcePath });
  }
}

function addDirectoryFiles(projectDir: string, root: string, files: BundleFileInput[]): void {
  const sourceRoot = path.join(projectDir, ...root.split('/'));
  if (!fs.existsSync(sourceRoot) || !fs.lstatSync(sourceRoot).isDirectory()) {
    throw new Error(`Binary target root is missing or not a directory: ${root}`);
  }
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Binary payload may not contain symlinks: ${absolute}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(projectDir, absolute).split(path.sep).join('/');
        files.push({ path: relative, sourcePath: absolute });
      } else {
        throw new Error(`Binary payload may contain only regular files and directories: ${absolute}`);
      }
    }
  };
  walk(sourceRoot);
}

type FrameworkAppliance = Extract<ApplianceFullInput, { type: 'framework' }>;

/**
 * Container appliances ship their build context: Dockerfile + source.
 * `.dockerignore` patterns are honored so the zip matches what a
 * local `docker build .` would have sent to the daemon.
 */
function packageContainerSource(archive: archiver.Archiver) {
  if (!fs.existsSync('Dockerfile')) {
    throw new Error('Container appliances need a Dockerfile next to appliance.json.');
  }
  console.log(chalk.dim('Packaging container build context (built server-side).'));
  packageBundle(archive, undefined, undefined, readDockerignore());
}

/** Best-effort .dockerignore → glob ignore patterns (skips negations). */
function readDockerignore(): string[] | undefined {
  if (!fs.existsSync('.dockerignore')) return undefined;
  return fs
    .readFileSync('.dockerignore', 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => (l.endsWith('/') ? `${l}**` : l));
}

function packageFramework(archive: archiver.Archiver, appliance: FrameworkAppliance, lambdaPrep: boolean) {
  const framework = appliance.framework === 'auto' ? detectFramework() : appliance.framework;

  if (!lambdaPrep) {
    // Container-runtime target: the server generates a Dockerfile and
    // builds from source — dependencies install inside the image, so
    // host node_modules/venvs are excluded noise, not payload.
    console.log(chalk.dim('Packaging framework source (built server-side).'));
    packageBundle(archive, undefined, appliance.includes, appliance.excludes);
    return;
  }

  installDependencies(framework);

  const port = appliance.port ?? 8080;
  const startCommand = appliance.scripts?.start ?? defaultStartCommand(framework);
  const lines = ['#!/bin/bash', `export PORT=${port}`];
  if (framework === 'python') {
    lines.push(`source ${PYTHON_VENV_DIR}/bin/activate`);
  }
  lines.push(`exec ${startCommand}`);
  fs.writeFileSync('run.sh', lines.join('\n'), { mode: 0o755 });
  console.log(chalk.dim(`Generated run.sh: ${startCommand}`));

  packageBundle(archive, framework, appliance.includes, appliance.excludes);

  archive.on('end', () => {
    try {
      fs.unlinkSync('run.sh');
    } catch {
      // ignore
    }
    try {
      fs.rmSync(PYTHON_VENV_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
}

function installDependencies(framework: string | undefined) {
  if (framework === 'python' && fs.existsSync('requirements.txt')) {
    console.log(chalk.dim('Creating virtual environment and installing dependencies...'));
    try {
      execFileSync('python', ['-m', 'venv', PYTHON_VENV_DIR], { stdio: 'inherit' });
      execFileSync(`${PYTHON_VENV_DIR}/bin/pip`, ['install', '-r', 'requirements.txt', '-q'], { stdio: 'inherit' });
    } catch {
      throw new Error('Failed to install Python dependencies.');
    }
  }
}

function detectFramework(): string {
  if (fs.existsSync('package.json')) return 'node';
  if (fs.existsSync('requirements.txt')) return 'python';
  if (fs.existsSync('Pipfile')) return 'python';
  if (fs.existsSync('pyproject.toml')) return 'python';
  return 'node';
}

function defaultStartCommand(framework: string | undefined): string {
  if (framework === 'python') {
    return 'python app.py';
  }
  if (fs.existsSync('package.json')) {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    if (pkg.scripts?.start) return 'npm start';
  }
  return 'node index.js';
}

function packageBundle(archive: archiver.Archiver, framework?: string, includes?: string[], excludes?: string[]) {
  const defaultExcludes = framework === 'node' ? [] : ['node_modules/**'];
  const ignorePatterns = [...ALWAYS_EXCLUDES, ...defaultExcludes, ...(excludes ?? [])];

  if (includes && includes.length > 0) {
    for (const pattern of includes) {
      archive.glob(pattern, { ignore: ignorePatterns });
    }
  } else {
    archive.glob('**/*', { ignore: ignorePatterns });
  }
}
