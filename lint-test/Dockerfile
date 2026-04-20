# DL3007: Using latest is best avoided
# DL3008: Pin versions in apt-get install
# DL3009: Delete apt-get lists after installing
FROM debian:latest

RUN apt-get update && apt-get install -y curl wget

WORKDIR /app

COPY . .

CMD bash
