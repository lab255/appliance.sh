FROM nginx:1.29-alpine

RUN printf '%s\n' \
  '<!doctype html>' \
  '<html><head><title>Journal</title></head>' \
  '<body><main><h1>Journal</h1><p>Your private page is running inside Appliance.</p></main></body></html>' \
  > /usr/share/nginx/html/index.html
