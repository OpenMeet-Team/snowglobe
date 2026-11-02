# The globe's image service (server.mjs): no dependencies, Node's own http and fetch.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
