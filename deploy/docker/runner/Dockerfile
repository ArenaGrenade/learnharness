FROM nvidia/cuda:12.9.1-base-ubuntu24.04@sha256:29e5e3425e2e0f5a4e97c9fb4695ba4887cd78210a43cf94c3bcafc6ab01c5e6
# Keep the CUDA minor version fixed. No framework/package installers run per job.
RUN apt-get update && apt-get install -y --no-install-recommends python3 g++ rustc cargo cuda-nvcc-12-9 cuda-cudart-dev-12-9 && rm -rf /var/lib/apt/lists/*
COPY deploy/docker/runner/execute.py /opt/runner/execute.py
COPY plugins/coding-questions/runner/languages.json /opt/runner/languages.json
ENV PATH="/usr/local/cuda/bin:${PATH}"
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["python3", "/opt/runner/execute.py"]
