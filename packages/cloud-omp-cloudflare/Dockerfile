FROM --platform=linux/amd64 ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.0-alpha.1@sha256:42ad8d95908fc62336bc74e1ab724df954af7357d1abb13c6a685af21b01b795 AS computerd

FROM --platform=linux/amd64 node:22-trixie-slim@sha256:c14465d88b83d14caaaa7e6e1f3efa49776a9868dc9713dddf7c79af3abb1d83

RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2t64 ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
RUN mkdir -p /opt/cloud-omp && printf '%s\n' 'cloud-omp-provider-v1' > /opt/cloud-omp/provider-sentinel

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
