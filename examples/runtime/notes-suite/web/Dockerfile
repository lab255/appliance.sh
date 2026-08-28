FROM busybox:1.37

COPY index.html /www/index.html
COPY entrypoint.sh /entrypoint.sh
RUN chmod -R a+rX /www

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
