# SearXNG for Offline AI - deployable as a free Render web service.
#
# Render: New + Web Service -> this repo -> Root Directory: searxng -> Runtime: Docker
# Then copy the resulting https://xxxx.onrender.com URL into the licence server's
# SEARXNG_URL environment variable.
FROM searxng/searxng:latest

COPY settings.yml /etc/searxng/settings.yml

EXPOSE 8080
