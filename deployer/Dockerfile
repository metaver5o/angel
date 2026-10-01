FROM python:3.12-alpine
# git for pulls; safe.directory '*' because the bind-mounted repo is owned by
# the host user, not root inside the container.
RUN apk add --no-cache git && git config --system --add safe.directory '*'
WORKDIR /app
COPY server.py .
EXPOSE 8090
CMD ["python", "server.py"]
