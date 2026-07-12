FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git python3 ca-certificates gnupg procps unzip sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY docker/e2e/agmsg-scripts/ /opt/agmsg/scripts/
RUN chmod -R +x /opt/agmsg/scripts && chmod -R a+w /opt/agmsg
ENV AGMSG_SCRIPTS_DIR=/opt/agmsg/scripts

RUN useradd -m -s /bin/bash agent

USER agent
ENV HOME=/home/agent

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/agent/.bun/bin:${PATH}"

RUN curl -fsSL https://herdr.dev/install.sh | sh
ENV PATH="/home/agent/.local/bin:${PATH}"

RUN npm config set prefix /home/agent/.npm-global \
    && npm install -g @anthropic-ai/claude-code
ENV PATH="/home/agent/.npm-global/bin:${PATH}"

RUN printf '%s\n' \
    '{"firstStartTime":"2025-01-01T00:00:00.000Z",' \
    '"machineID":"e2e-fixed-machine-id",' \
    '"userID":"e2e-fixed-user-id",' \
    '"numStartups":10,' \
    '"installMethod":"npm",' \
    '"autoUpdates":false,' \
    '"hasCompletedOnboarding":true,' \
    '"lastOnboardingVersion":"2.1.201",' \
    '"hasTrustDialogAccepted":true,' \
    '"hasTrustDialogHooksAccepted":true,' \
    '"hasCompletedProjectOnboarding":true,' \
    '"hasAcknowledgedCostThreshold":true,' \
    '"bypassPermissionsModeAccepted":true,' \
    '"dangerouslySkipPermissionsAccepted":true,' \
    '"theme":"dark",' \
    '"migrationVersion":13,' \
    '"opusProMigrationComplete":true,' \
    '"sonnet1m45MigrationComplete":true,' \
    '"effortCalloutV2Dismissed":true,' \
    '"projects":{"/workspace":{"hasTrustDialogAccepted":true,"hasTrustDialogHooksAccepted":true,"hasCompletedProjectOnboarding":true}},' \
    '"seenNotifications":{},' \
    '"changelogLastFetched":0}' > /home/agent/.claude.json

RUN mkdir -p /home/agent/.claude && \
    printf '%s\n' '{"theme":"dark","hasCompletedOnboarding":true}' > /home/agent/.claude/settings.json

ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) opencode_arch=x64 ;; arm64) opencode_arch=arm64 ;; *) exit 1 ;; esac \
    && curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v1.17.13/opencode-linux-${opencode_arch}.tar.gz" -o /tmp/opencode.tar.gz \
    && tar xzf /tmp/opencode.tar.gz -C /tmp \
    && mkdir -p /home/agent/.opencode/bin \
    && mv /tmp/opencode /home/agent/.opencode/bin/opencode \
    && chmod +x /home/agent/.opencode/bin/opencode \
    && rm -rf /tmp/opencode*
ENV PATH="/home/agent/.opencode/bin:${PATH}"

RUN ln -sf /workspace/bin/herdr-symphony /home/agent/.local/bin/herdr-symphony

WORKDIR /workspace
