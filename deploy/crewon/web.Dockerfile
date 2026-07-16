FROM nginx:1.27.5-alpine

COPY dist/ /usr/share/nginx/html/
