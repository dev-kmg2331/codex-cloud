#!/bin/sh
set -eu

cd /home/omeye/webcodecs
test -x .venv/bin/python
test -f .env
test -f dist/index.html

install -d -m 700 /etc/nginx/webcodecs-tls
if [ ! -s /etc/nginx/webcodecs-tls/webcodecs.crt ] || [ ! -s /etc/nginx/webcodecs-tls/webcodecs.key ]; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
        -subj '/CN=192.168.182.239' \
        -addext 'subjectAltName=IP:192.168.182.239,IP:127.0.0.1,DNS:localhost' \
        -keyout /etc/nginx/webcodecs-tls/webcodecs.key \
        -out /etc/nginx/webcodecs-tls/webcodecs.crt
    chmod 600 /etc/nginx/webcodecs-tls/webcodecs.key
fi
install -m 644 deploy/239/webcodecs.service /etc/systemd/system/webcodecs.service
install -m 644 deploy/239/webcodecs.conf /etc/nginx/conf.d/webcodecs.conf
nginx -t
systemctl daemon-reload
systemctl enable webcodecs.service
systemctl restart webcodecs.service
systemctl reload nginx
install -m 644 /etc/nginx/webcodecs-tls/webcodecs.crt /home/omeye/webcodecs/server.crt
systemctl --no-pager is-active webcodecs.service nginx.service
