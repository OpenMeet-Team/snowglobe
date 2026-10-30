# Jetstream (github.com/bluesky-social/jetstream), the firehose as JSON for apps. It serves v2,
# /xrpc/network.bsky.jetstream.subscribeEvents, which contrail and @bsky/jetstream read, and the
# older /subscribe, which Slingshot, PDSls and the network page read.
# To move to another Jetstream, change the second FROM line. snowglobe up builds the new image,
# since the image's tag is a hash of this file.
# The image has no shell, so busybox comes along for the health check. It runs as root so it can
# write the jetstream-data volume, which Docker makes root's.
FROM busybox:1.37.0-musl@sha256:f6a95d611e0a8780fabdb2aec43e31275b2720dfefa3e41b16835bfc42454478 AS tools

FROM ghcr.io/bluesky-social/jetstream:v0.4.6@sha256:38e927566ed2aca19ffd2e9f3c440db74ffb404000aaf493b215dfefc6c7e54c
COPY --from=tools /bin/busybox /busybox
USER 0:0
