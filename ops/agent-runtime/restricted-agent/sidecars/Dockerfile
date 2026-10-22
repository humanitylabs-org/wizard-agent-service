# Sidecars for the restricted agent runtime: egress allowlist proxy, scoped gateway edge, and the
# one-shot home-init. Built into an image so the runtime needs no host file mounts.
FROM python:3.12-slim
COPY egress.py upstream_dns.py edge.py home-init.sh /srv/
RUN chmod 0555 /srv/egress.py /srv/edge.py /srv/home-init.sh
USER 65534:65534
