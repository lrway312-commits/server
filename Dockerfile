# Use Node 20 for better global coverage (crypto, fetch, etc)
FROM node:20-bullseye

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update --fix-missing && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    git \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

# Ensure the temp directory exists
RUN mkdir -p /tmp/auth_baileys && chmod 777 /tmp/auth_baileys

EXPOSE 7860

CMD ["node", "bridge.js"]
