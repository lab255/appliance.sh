FROM nginx:1.29-alpine

RUN printf '%s\n' \
  '<!doctype html>' \
  '<html><head><title>Journal</title></head>' \
  '<body><main><h1>Journal</h1><p>journal runtime proof — your private page is running inside Appliance.</p></main></body></html>' \
  > /usr/share/nginx/html/index.html

# The packaged builder example declares 80; AP-163's architecture-local
# live fixture declares 3000. One reproducible image serves both proofs.
RUN sed -i '/listen       80;/a\        listen       3000;' /etc/nginx/conf.d/default.conf
EXPOSE 80 3000
