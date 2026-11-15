FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend backend
COPY frontend frontend
ENV INGRESS_CACHE=/tmp/ingress-cache
# Prepare the test targets' images in the background when the server starts.
ENV INGRESS_PREWARM=1
EXPOSE 8000
CMD ["sh", "-c", "uvicorn backend.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
