import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import { applianceV2Input } from '@appliance.sh/sdk';
import { extractApplianceFile, registerManifestOptions, resolveApplianceDir } from './utils/common.js';
import { buildApplianceZip, packageRunnableAppliance } from './utils/build-package.js';
import chalk from 'chalk';

// When invoked directly (commander dispatch covers this too), make
// sure helper-installed docker / kubectl / crane resolve on PATH.
ensureHelperBinOnPath();

const DEFAULT_OUTPUT = 'appliance.zip';

const program = new Command();
const packageMode = process.argv[1]?.endsWith('appliance-package') ?? false;

if (packageMode) {
  const collectImage = (value: string, previous: string[]) => [...previous, value];
  registerManifestOptions(program)
    .description('package a manifest v2 project as a runnable .appliance.zip bundle')
    .option('-o, --out <file>', 'output file (defaults to <manifest-name>.appliance.zip)')
    .option('--sign <dev-key-file>', 'sign with a local development Ed25519 key file')
    .option(
      '--image <selector=ref-or-tar>',
      'use a prebuilt image ref/tar (repeatable; selector is platform or payload path)',
      collectImage,
      []
    )
    .action(async () => {
      const opts = program.opts<{
        out?: string;
        sign?: string;
        image: string[];
        file?: string;
        directory?: string;
      }>();
      const projectDir = resolveApplianceDir(program);
      const manifestPath =
        opts.file && opts.file !== 'appliance.json'
          ? path.resolve(process.cwd(), opts.file)
          : path.join(projectDir, 'appliance.json');
      if (!fs.existsSync(manifestPath)) {
        console.error(chalk.red(`No appliance.json found at ${manifestPath}.`));
        process.exit(1);
      }

      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        if (raw.manifest === 'v1') {
          throw new Error(
            'This is a manifest v1 source project. `appliance package` only emits runnable manifest v2 bundles; ' +
              'use `appliance build` to create the existing source bundle.'
          );
        }
        const parsed = applianceV2Input.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          throw new Error(`Invalid manifest v2: ${issues}`);
        }
        const outputPath = path.resolve(opts.out ?? `${parsed.data.name}.appliance.zip`);
        const result = await packageRunnableAppliance({
          manifest: parsed.data,
          projectDir,
          outputPath,
          signingKeyPath: opts.sign ? path.resolve(opts.sign) : undefined,
          images: opts.image,
        });
        const sizeMb = (result.sizeBytes / 1024 / 1024).toFixed(1);
        console.log(chalk.green(`Packaged: ${result.outputPath} (${sizeMb} MB)`));
        console.log(chalk.dim(`Digest: ${result.digest}`));
        if (result.keyId) console.log(`Publisher keyId: ${result.keyId}`);
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
} else {
  registerManifestOptions(program)
    .description('build an appliance and package it as appliance.zip')
    .option('-o, --output <output>', 'output file', DEFAULT_OUTPUT)
    .option(
      '--upload-url <url>',
      'after packaging, PUT the zip to this URL (plumbing: the desktop deploy wizard mints a one-time ' +
        'upload URL via the api-server and drives this command through the bundled CLI); without an ' +
        'explicit -o the zip is written to a temp file and removed after the upload'
    )
    .option(
      '--no-lambda-prep',
      'skip Lambda zip-runtime prep (host-side dependency install + run.sh) for framework apps — pass ' +
        'when the target base builds container images from source'
    )
    .option('--json', 'emit NDJSON progress events (type: log | error | result) instead of human output')
    .action(async () => {
      const opts = program.opts<{ output: string; uploadUrl?: string; lambdaPrep: boolean; json?: boolean }>();
      const json = Boolean(opts.json);
      const emit = (event: object) => console.log(JSON.stringify(event));
      const info = (message: string, human: string = message) =>
        json ? emit({ type: 'log', level: 'info', message }) : console.log(human);
      const fail = (message: string): never => {
        if (json) emit({ type: 'error', error: message });
        else console.error(chalk.red(message));
        return process.exit(1);
      };

      const applianceFile = await extractApplianceFile(program);
      if (!applianceFile.success) {
        return fail(applianceFile.error.message);
      }

      // With --upload-url the zip is a transport detail, not an artifact
      // the user asked to keep: write it into a temp dir unless they
      // named an output explicitly, and always remove the temp copy.
      const outputExplicit = program.getOptionValueSource('output') !== 'default';
      const tempDir =
        opts.uploadUrl && !outputExplicit ? fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-build-')) : null;
      const outputPath = tempDir ? path.join(tempDir, DEFAULT_OUTPUT) : path.resolve(opts.output);

      try {
        const result = await buildApplianceZip({
          appliance: applianceFile.data,
          outputPath,
          lambdaPrep: opts.lambdaPrep,
        });
        const sizeMb = (result.sizeBytes / 1024 / 1024).toFixed(1);
        info(`Built: ${result.outputPath} (${sizeMb} MB)`, chalk.green(`Built: ${result.outputPath} (${sizeMb} MB)`));

        if (opts.uploadUrl) {
          info(`Uploading source (${sizeMb} MB)…`);
          const data = fs.readFileSync(result.outputPath);
          // Raw PUT, mirroring ApplianceClient.uploadBuild: the URL is
          // presigned/one-time-token authorized, so no request signing.
          const res = await fetch(opts.uploadUrl, {
            method: 'PUT',
            headers: { 'content-type': 'application/zip' },
            body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
            signal: AbortSignal.timeout(300_000),
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`upload failed: HTTP ${res.status}${body ? `: ${body}` : ''}`);
          }
          info('Source uploaded.', chalk.green('Source uploaded.'));
        }

        if (json) {
          emit({ type: 'result', result: { sizeBytes: result.sizeBytes, uploaded: Boolean(opts.uploadUrl) } });
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      } finally {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
}

program.parse(process.argv);
