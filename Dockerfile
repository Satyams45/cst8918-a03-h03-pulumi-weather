# base node image
FROM node:lts-alpine AS base
 
# update the openssl package to apply a security patch @see CVE-2023-6129
RUN apk -U add --update-cache openssl
 
# set for base and all layers that inherit from it
ENV NODE_ENV=production
 
# Install all node_modules, including dev dependencies
FROM base AS deps
 
WORKDIR /usr/src/app
ADD package.json ./
RUN npm install --include=dev
 
# Setup production node_modules
FROM base AS production-deps
 
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules /usr/src/app/node_modules
ADD package.json ./
RUN npm prune --omit=dev
 
# Build the app
FROM base AS build
 
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules /usr/src/app/node_modules
ADD . .
RUN npm run build
 
# Production stage: Build the production image with a minimal footprint
FROM base AS production
 
WORKDIR /usr/src/app
COPY --from=production-deps /usr/src/app/node_modules /usr/src/app/node_modules
COPY --from=build /usr/src/app/build /usr/src/app/build
COPY --from=build /usr/src/app/public /usr/src/app/public
COPY --from=build /usr/src/app/package.json /usr/src/app/package.json
 
# Expose port 80
EXPOSE 80
 
CMD [ "/bin/sh", "-c", "./node_modules/.bin/remix-serve ./build/index.js" ]