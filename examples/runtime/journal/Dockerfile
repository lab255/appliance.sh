FROM busybox:1.37
COPY index.html /www/index.html
EXPOSE 3000
CMD ["httpd", "-f", "-p", "3000", "-h", "/www"]
