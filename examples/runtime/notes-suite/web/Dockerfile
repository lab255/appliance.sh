FROM busybox:1.37

COPY index.html /www/index.html
RUN chmod -R a+rX /www

EXPOSE 3000
CMD ["httpd", "-f", "-p", "3000", "-h", "/www"]
