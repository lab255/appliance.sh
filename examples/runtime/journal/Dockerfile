FROM busybox:1.37

COPY entrypoint.sh /entrypoint.sh
RUN mkdir /www && printf '%s\n' \
  '<!doctype html>' \
  '<html><head><title>Journal</title></head>' \
  '<body><main><h1>Journal</h1><p>journal runtime proof — your private page is running inside Appliance.</p></main></body></html>' \
  > /www/index.html && chmod -R a+rX /www

# The Runtime supervisor supplies the app's stable unprivileged UID and
# drops all Linux capabilities; use an unprivileged listener accordingly.
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
