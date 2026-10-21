FROM python:3.12-slim
COPY fake_service.py /srv/fake_service.py
RUN mkdir /gate-one /gate-two && chown 65534:65534 /gate-one /gate-two && chmod 700 /gate-one /gate-two
USER 65534:65534
