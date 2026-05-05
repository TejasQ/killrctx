# Patches the upstream openrag-backend image so it talks to OpenSearch over
# plain http with no auth. Required when running OpenSearch with
# DISABLE_SECURITY_PLUGIN=true (see docker-compose.yml). The base image
# hardcodes use_ssl=True and http_auth=(admin, password) in
# /app/src/config/settings.py, so we sed those out at build time.
ARG OPENRAG_VERSION=latest
FROM langflowai/openrag-backend:${OPENRAG_VERSION}

RUN sed -i \
  -e 's|use_ssl=True|use_ssl=False|g' \
  -e 's|scheme="https"|scheme="http"|g' \
  -e 's|http_auth=(OPENSEARCH_USERNAME, OPENSEARCH_PASSWORD),|http_auth=None,|g' \
  /app/src/config/settings.py
