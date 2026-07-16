ARG BASE_IMAGE=nginx:1.27.5-alpine
FROM ${BASE_IMAGE}

COPY dist/ /usr/share/nginx/html/
