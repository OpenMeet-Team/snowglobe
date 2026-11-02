# indigo's collection directory: which accounts hold records in which collection. It answers
# com.atproto.sync.listReposByCollection, which an app's backfill asks a relay for; the relay
# itself does not answer it (indigo's firehose splitter, rainbow, sends that one path to this
# service instead), so nginx does the same on relay.<domain>.
#
# Built from the same indigo commit as the relay (relay/Dockerfile), with two patches to its
# crawl of a PDS (listRepos, then describeRepo for each account):
# - allow-private-hosts.patch: the crawl goes through an SSRF-safe transport that refuses private
#   addresses, and a snowglobe's PDS names resolve to nginx's. It now honors
#   COLLECTIONS_ALLOW_PRIVATE_HOSTS=true, as the relay's patch does RELAY_ALLOW_PRIVATE_HOSTS.
#   Its firehose dialer has no such check.
# - crawl-qps.patch: serve never reads --crawl-qps, so a crawl's rate limit is 0 and it waits
#   forever after the first listRepos. It now reads the flag (default 100). Unfixed upstream
#   as of indigo main 15edb2cd (2026-10-30).

ARG INDIGO_COMMIT=b2619d864df00a66455bd9f5f0c83c1ac13ad73d

FROM golang:1.26-alpine3.22 AS build
ARG INDIGO_COMMIT
RUN apk add --no-cache build-base git
WORKDIR /src
RUN git init -q \
 && git remote add origin https://github.com/bluesky-social/indigo.git \
 && git fetch -q --depth 1 origin "${INDIGO_COMMIT}" \
 && git checkout -q FETCH_HEAD
COPY allow-private-hosts.patch crawl-qps.patch /tmp/
RUN git apply /tmp/allow-private-hosts.patch /tmp/crawl-qps.patch
RUN go build -tags timetzdata -o /collectiondir ./cmd/collectiondir

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /collectiondir /usr/bin/collectiondir
ENTRYPOINT ["/usr/bin/collectiondir"]
