# Shared base for both the build and final stages. Pinned to the
# exact Node version used everywhere else (see /.nvmrc and the root
# package.json's `engines.node`) so the in-image runtime matches the
# host runtime devs and CI use to compile the workspace. Buildkit
# resolves this to the appropriate platform manifest per shard.
#
# Steps placed here are the universally-needed setup: corepack
# (pnpm), HUSKY=0, curl + ca-certificates, Pulumi CLI. Anything else
# (crane, unzip, app deps) belongs to the stage that needs it so the
# layer cache stays granular.
FROM node:24.14.1-slim AS base

ARG BUILDPLATFORM
ARG TARGETPLATFORM
RUN printf 'base stage: BUILDPLATFORM=%s TARGETPLATFORM=%s uname=%s\n' \
    "$BUILDPLATFORM" "$TARGETPLATFORM" "$(uname -m)"

# Disable husky git hooks (not needed in Docker).
ENV HUSKY=0

# Install curl + ca-certificates (slim image lacks them) and Pulumi.
# Pulumi CLI is pinned to match the @pulumi/pulumi node SDK version
# from the workspace lockfile — version skew between CLI and SDK has
# caused segfaults in `pulumi stack history` (observed on CLI 3.232
# against SDK 3.227). Bump this in lockstep with packages/infra's
# @pulumi/pulumi resolution to avoid drift.
#
# Pulumi installs to /root/.pulumi/bin by default. On Lambda the
# container runs as a non-root user that cannot traverse /root
# (mode 0700), so we relocate the binaries to /usr/local/bin where
# they are world-executable.
ARG PULUMI_CLI_VERSION=3.227.0
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://get.pulumi.com | sh -s -- --version "${PULUMI_CLI_VERSION}" \
    && cp /root/.pulumi/bin/* /usr/local/bin/ \
    && rm -rf /root/.pulumi \
    && pulumi version

# corepack/pnpm — both stages drive workspace installs through pnpm.
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# --- Build stage ---
# Native build on the runner's architecture for speed; output is
# arch-independent JavaScript so cross-compiling isn't needed.
FROM --platform=$BUILDPLATFORM base AS build

# Copy root workspace config (staged by docker-prep.sh)
COPY .docker-deps/root-package.json package.json
COPY .docker-deps/pnpm-lock.yaml pnpm-lock.yaml
COPY .docker-deps/pnpm-workspace.yaml pnpm-workspace.yaml

# Copy workspace package.json files for install
COPY .docker-deps/sdk/package.json packages/sdk/
COPY .docker-deps/infra/package.json packages/infra/
COPY package.json packages/api-server/

# Install api-server dependencies via workspace
RUN pnpm install --frozen-lockfile --filter @appliance.sh/sdk --filter @appliance.sh/infra --filter @appliance.sh/api-server

# Copy pre-built SDK and infra
COPY .docker-deps/sdk/dist/ packages/sdk/dist/
COPY .docker-deps/infra/dist/ packages/infra/dist/

# Copy api-server source and build
COPY .docker-deps/root-tsconfig.json tsconfig.json
COPY tsconfig.json packages/api-server/
COPY tsconfig.build.json packages/api-server/
COPY src/ packages/api-server/src/
RUN pnpm --filter @appliance.sh/api-server run build

# --- LWA stage (pulls the lambda-adapter binary) ---
FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.0 AS lwa

# --- Final stage ---
# Defaults to TARGETPLATFORM; buildkit warns if we make that explicit.
FROM base

# Lambda Web Adapter: copied in as an extension, inert outside Lambda
# (activates only when AWS_LAMBDA_RUNTIME_API is set). Lets this same
# image run as a regular HTTP container locally and as a Lambda
# container in AWS without code changes.
COPY --from=lwa /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=3000

# Final-stage-only tooling: unzip (used by build.service.ts to
# validate + extract uploaded appliance build zips) and crane (used
# to push container images to ECR without a Docker daemon).
#
# TARGETARCH is auto-set by buildx; crane's release asset naming
# uses x86_64 / arm64 so we map from Docker's amd64 / arm64 form.
ARG TARGETARCH
ARG CRANE_VERSION=v0.20.6
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH:-amd64}" in \
         amd64) CRANE_ARCH=x86_64 ;; \
         arm64) CRANE_ARCH=arm64 ;; \
         *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && curl -sL "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_${CRANE_ARCH}.tar.gz" \
       | tar -xzf - -C /usr/local/bin crane

# Crane writes its auth config to $DOCKER_CONFIG (or $HOME/.docker by default).
# On Lambda $HOME points at a read-only sandbox dir, so we direct crane at /tmp
# which is the only writable filesystem in the Lambda execution environment.
ENV DOCKER_CONFIG=/tmp/.docker

COPY .docker-deps/root-package.json package.json
COPY .docker-deps/pnpm-lock.yaml pnpm-lock.yaml
COPY .docker-deps/pnpm-workspace.yaml pnpm-workspace.yaml
COPY .docker-deps/sdk/package.json packages/sdk/
COPY .docker-deps/infra/package.json packages/infra/
COPY package.json packages/api-server/

RUN pnpm install --frozen-lockfile --prod --filter @appliance.sh/sdk --filter @appliance.sh/infra --filter @appliance.sh/api-server

# Precache the Pulumi resource plugins that ApplianceDeploymentService uses.
# Versions are read from the installed node_modules so they track whatever
# pnpm resolved from the lockfile — no hardcoded list to drift. The plugin
# binaries land in /opt/pulumi-cache/plugins and are symlinked into the
# runtime PULUMI_HOME by ApplianceDeploymentService.ensurePluginCache at
# first use, avoiding a 150+ MB cold-start download.
RUN set -eux; \
    AWS_VERSION=$(node -p "require('./packages/infra/node_modules/@pulumi/aws/package.json').version"); \
    AWS_NATIVE_VERSION=$(node -p "require('./packages/infra/node_modules/@pulumi/aws-native/package.json').version"); \
    AWSX_VERSION=$(node -p "require('./packages/infra/node_modules/@pulumi/awsx/package.json').version"); \
    PULUMI_HOME=/opt/pulumi-cache pulumi plugin install resource aws "v$AWS_VERSION"; \
    PULUMI_HOME=/opt/pulumi-cache pulumi plugin install resource aws-native "v$AWS_NATIVE_VERSION"; \
    PULUMI_HOME=/opt/pulumi-cache pulumi plugin install resource awsx "v$AWSX_VERSION"

# Copy built output
COPY --from=build /app/packages/sdk/dist/ packages/sdk/dist/
COPY --from=build /app/packages/infra/dist/ packages/infra/dist/
COPY --from=build /app/packages/api-server/dist/ packages/api-server/dist/

# Web console SPA (built host-side by docker-prep.sh). Served by the
# api-server at / so the server URL is the console URL.
COPY .docker-deps/console-dist/ packages/api-server/console-dist/

ENV PORT=3000
EXPOSE 3000

CMD ["node", "packages/api-server/dist/main.js"]
