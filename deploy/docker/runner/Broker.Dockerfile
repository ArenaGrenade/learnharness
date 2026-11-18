FROM python:3.13.9-slim-bookworm@sha256:b685a4fa58bb19d1814d78a1ec0f0208f351452724f78b20212c984d6e124a34
COPY deploy/docker/runner/broker.py /opt/runner/broker.py
COPY plugins/coding-questions/runner/languages.json /opt/runner/languages.json
USER 65534:65534
ENTRYPOINT ["python3", "/opt/runner/broker.py"]
